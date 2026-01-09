-- Migration: Create research_articles table for pre-fetched running content
-- Articles are fetched daily at 6 AM via cron job, eliminating load times in the app
-- Idempotent: safe to run multiple times

-- Create table for cached research articles
CREATE TABLE IF NOT EXISTS research_articles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    summary TEXT,
    content TEXT,
    url TEXT UNIQUE NOT NULL,
    image_url TEXT,
    author TEXT,
    source TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general',
    tags TEXT[] DEFAULT '{}',
    published_at TIMESTAMPTZ,
    fetched_at TIMESTAMPTZ DEFAULT NOW(),
    relevance_score DECIMAL(3,2) DEFAULT 0.80,
    -- Location fields for local events
    location_city TEXT,
    location_state TEXT,
    location_country TEXT,
    location_latitude DECIMAL(10,7),
    location_longitude DECIMAL(10,7),
    is_local_event BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add columns that might be missing (for existing tables)
DO $$
BEGIN
    -- Add is_active if missing (for soft deletes / hiding old content)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'research_articles' AND column_name = 'is_active') THEN
        ALTER TABLE research_articles ADD COLUMN is_active BOOLEAN DEFAULT TRUE;
    END IF;
END $$;

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_research_articles_category
    ON research_articles(category);

CREATE INDEX IF NOT EXISTS idx_research_articles_published
    ON research_articles(published_at DESC);

CREATE INDEX IF NOT EXISTS idx_research_articles_fetched
    ON research_articles(fetched_at DESC);

CREATE INDEX IF NOT EXISTS idx_research_articles_active_category
    ON research_articles(is_active, category, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_research_articles_url
    ON research_articles(url);

-- Enable RLS
ALTER TABLE research_articles ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist (for clean re-run)
DROP POLICY IF EXISTS "Service role full access" ON research_articles;
DROP POLICY IF EXISTS "Authenticated read access" ON research_articles;
DROP POLICY IF EXISTS "Public read access" ON research_articles;

-- Policy: Service role can do everything (used by edge functions)
CREATE POLICY "Service role full access" ON research_articles
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Policy: Anyone can read active articles (public content)
CREATE POLICY "Public read access" ON research_articles
    FOR SELECT
    TO anon, authenticated
    USING (is_active = true);

-- Trigger function for updated_at
CREATE OR REPLACE FUNCTION update_research_article_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop trigger if exists, then create
DROP TRIGGER IF EXISTS trigger_update_research_article_timestamp ON research_articles;

CREATE TRIGGER trigger_update_research_article_timestamp
    BEFORE UPDATE ON research_articles
    FOR EACH ROW
    EXECUTE FUNCTION update_research_article_updated_at();

-- Function to clean up old articles (older than 30 days)
CREATE OR REPLACE FUNCTION cleanup_old_research_articles()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM research_articles
    WHERE published_at < NOW() - INTERVAL '30 days';

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Grant permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON research_articles TO service_role;
GRANT SELECT ON research_articles TO anon;
GRANT SELECT ON research_articles TO authenticated;

-- Add comments for documentation
COMMENT ON TABLE research_articles IS 'Pre-fetched running/fitness articles from RSS feeds, updated daily at 6 AM';
COMMENT ON COLUMN research_articles.category IS 'Article category: health, nutrition, gear, training, events, general';
COMMENT ON COLUMN research_articles.relevance_score IS 'AI-calculated relevance score 0.0-1.0';
COMMENT ON COLUMN research_articles.is_active IS 'Soft delete flag - inactive articles hidden from queries';

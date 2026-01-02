import Anthropic from 'npm:@anthropic-ai/sdk@0.24.3'

export const createAnthropicClient = () => {
  return new Anthropic({
    apiKey: Deno.env.get('ANTHROPIC_API_KEY')!
  })
}

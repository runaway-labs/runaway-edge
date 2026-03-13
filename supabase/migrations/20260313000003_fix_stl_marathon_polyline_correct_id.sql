-- Fix St. Louis Marathon 2026 course polyline (runsignup_race_id=81794, event_id=996017)
-- Previous polyline used 27 mile markers causing straight lines through buildings
-- New polyline extracted from KML file's 14 LineString segments (241 street-following coords)
-- Segments chained in correct order: 0,1,2,6,7,5,3,4,8,9,11,10,12,13

UPDATE race_courses
SET polyline = 'kqwjFdppePtC}SPmAlFg\rLnDlBoL|AsE~c@zMFuArMo^q@cAsYcHa`@yLuO_FaKiB_K{@oBvVzJI~Bog@rA_Yb@XIzA_ArO_@fJg@`KkA~UV`BjCKfCd@hIvBZ}AoE{BoCk@uFOfDuEbAmAhAe@tAJhAGvC`@zC\nBJtC`A~B|AjB~@hBbAnA`AxBxAt@fAb@tAVlAf@nA`@Xl@]b@C|EbCjCvAmA`F|F|DaDnJdEtAaInq@|GdBzB`ArOhNbP~N`GfF`FdBxQbG|PbG|ChAzJnFjBbGrFt@xH`B{P_CaByFcKiG}]}LcJuCuEcBiNsLgMiLgGn\wFxYj@j@lRnBqBvZqTqClBgZvF{ZhG}\yG{FmBkBwJmCgv@_UyJ~t@}AnMYVyEza@W~CK`KNf`@H~XaKcCAtAVX_MbaAqDxYbXlGvD~EaEvZrYzGnEdu@eSoFkIoBwFqACpTe@`h@??pAhVgB_@_@DiBRyBD{B?wBIaCe@eAe@uA^sC|AyH~DwAbAwAdA}@zAe@fAc@hEm@p@aAn@u@`@iATkAXkA\}@Zi@|@q@vCi@nC?hBHhBFtBr@@x@Cx@^f@pA`AdCb@hAj@v@La@V[d@Yh@OFeCF}ABiANeAj@_C\qBP{CJcCHoAWGElBM~BMtB[~By@nDKjBIhEUFs@\_@n@c@m@e@oAi@{Ae@eA_@o@m@M}@Eg@DIgBI{CFeAp@iDl@_C~@o@lAa@vCm@|Aq@~AaB\_E|A_DtBaB`E{BvHeExAe@bCr@nC\dE?dFY~B\yAaV\ia@D}ETqSbQtDtI`CzEtAfBGsAgR}B}Za@_GeMoCiKaCbEuZaE_FmKkCeKeClFec@xJow@Y]@aA`KfCYo|@LaIPcCrBoQ}C}BeFgAlKyy@bHfBaDzV'
WHERE runsignup_race_id = 81794 AND event_id = 996017;

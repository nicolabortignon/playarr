# Listening and generated mixes

This is how Playarr learns from what's played and turns it into music: the play reports, the taste model, the twelve "Made for you" mixes, radio, Jump back in, listening stats and the year in review, and what ListenBrainz adds. The server side lives in `apps/server/src/mixes` (history, taste, generators, stats), `apps/server/src/listenbrainz` (sending plays) and `apps/server/src/discover/listenbrainz.ts` (reading ListenBrainz data); the routes are in `apps/server/src/routes/mixes.ts`. Ordering songs so neighbours blend is `packages/mix/src/blend.ts`, shared with the DJ mix engine ([mixing.md](mixing.md)).

Everything here is per account: history, mixes, stats and the ListenBrainz link follow whoever is signed in (see [server/accounts-and-access.md](server/accounts-and-access.md)). How mixes are made is the server's, set by admins.

---

## 1. Play reports (`POST /api/plays`)

The player reports each song once it stops being the current one (`apps/web/src/player/playTracker.ts`; the iOS app's `PlayTracker.swift` follows it rule for rule). It counts only time actually heard: seeks and pauses don't add to it.

- **Played**: heard for at least 30 s, or half of a shorter song.
- **Skipped**: left for another song after 3 to 30 s of it. Under 3 s is browsing, not a verdict, and isn't reported. A song that simply ends short of 30 s isn't a skip either.

Each report carries the song (track id and recording id), when it started, the device's local hour and weekday, the seconds heard and whether it was skipped. Reports that can't be sent (offline, server restarting) wait on the device (up to 300) and go with the next one, one request at a time. The server stores each report once (`plays`, unique on account, recording and start time), so a report sent twice after a lost answer counts once. Songs that leave the library keep their history by recording id.

Two switches stop reports:

- **Count what this device plays** (Settings → Playback, per device, on by default): off for a party speaker or a guest's phone. The device simply doesn't send.
- **Remember what's played** (Settings → Mixes, server-wide): off, the server accepts reports and drops them (`202`, `recorded: 0`). Mixes go on using what's already there.

---

## 2. The taste model (`taste.ts`)

Mixes are made from the last 365 days of an account's plays, its favourites and its playlists.

**Each song** gets a score: every full play counts 0.5^(age / 60 days) (a half-life of 60 days), each skip −0.5, a favourite +3, and each time it appears in the account's own or shared playlists +1 (at most +3). **Song affinity** is that score scaled so the best song is 1. **Artist affinity** is the sum of an artist's positive song scores, scaled the same way. The account's **style** is its style families weighted by song score. A song skipped more often than it's played sinks: most mixes take 0.3 off its score.

**What a song is known by** (`toSong`):

- **Style**: ListenBrainz tags (section 7), folded into style families by `apps/server/src/analysis/styles.ts`; without tags, the album's genres, else the artist's.
- **Energy** (0–1): from measured sound where sound analysis has run (loudness, busyness, pulse and tempo); otherwise estimated from the style families (metal high, classical low), less a little for calm tags. Unknown without either.
- **Calm** and **focus**: from tags (calm, instrumental, ambient, post-rock, piano…) and families (chill, classical, cinematic, jazz).
- **Year**: the album's, else ListenBrainz's first release year. **Added**: when its album arrived. **Release date**: only real dates, not bare years.
- **Tempo and key**: a summary of its mix map from beat analysis, for blending.

**The hour's profile** (for Vibes of the hour and Feeling lucky) is what was heard within an hour of now: the same hour counts 1, the hours either side 0.6, and plays on the same kind of day (weekday or weekend) count 1.5 times as much. Under 15 such plays there's no profile, and a time-of-day default stands in: mornings easy and bright, daytime upbeat, evenings warm, late nights quiet and deep.

---

## 3. Made for you (`mixes.ts`, `generators.ts`)

| Mix | What it picks | Remade |
|---|---|---|
| **Vibes of the hour** | Half songs heard around this hour, half others in the same mood: the hour's artists, styles and energy. Without a profile, the time of day's default. | every hour |
| **Discovery Weekly** | Library songs the account has never played or skipped, nor favourited or put in a playlist, from artists and styles it likes, plus ListenBrainz neighbours of its 10 best-liked songs. *Familiar* leans on known artists, *Adventurous* on unknown ones. | every Monday |
| **On Repeat** | The most played songs of the last 30 days (at least 2 plays each), most played first. | daily |
| **Blast from the past** | Songs played at least 3 times, not heard for the chosen 30–365 days. Short of history: loved songs not heard lately, then songs from albums added over a year ago and never played. | daily |
| **Genre mixes** | One per style family with the most songs, weighted by what the account likes (at least 30 songs), e.g. "Electronic mix". | daily |
| **Deep cuts** | Songs by the account's 20 favourite artists that have no liking of their own yet: unplayed, not favourites, not in playlists (needs at least 2 such artists). | daily |
| **Fresh arrivals** | Up to 3 unplayed songs from each album added in the last 30 days, newest albums first. | daily |
| **Time machine** | One per decade with the most songs, weighted by what the account likes (at least 30 songs), e.g. "The 90s". | daily |
| **Energy boost** | Energy 0.62 and up, not calm; building up. | daily |
| **Deep focus** | Focus-leaning songs of middling energy (0.12–0.6). | daily |
| **Wind down** | Energy 0.38 or less, or calm by their tags; settling down. | daily |
| **On this day** | Songs from albums released within 3 days of today's date in past years, up to 3 per album, oldest first. | daily |

Home shows them in that order (`planMixes`). Common rules:

- At most 2 songs per artist (3 in Blast from the past and Deep cuts), and never the same artist twice in a row where it can be helped.
- A mix with fewer than 8 songs isn't shown. Songs per mix is a setting (25–100).
- Each mix is seeded by its key and period, so it doesn't reshuffle on every visit. **New mix** (`POST /api/mixes/:key/regenerate`) draws another for the same period. **Save** (`POST /api/mixes/:key/save`) keeps it as an ordinary playlist named "<mix> · 5 Nov".
- Mixes are stored by recording id (table `mixes`, one row per account and mix), so they survive restarts and matching.

**Schedules and the household time zone.** A mix belongs to a period: the local hour for Vibes, the ISO week for Discovery Weekly (so it changes on Mondays), the local date for the rest. Which mixes exist (and which genres and decades get one) is decided once a day, or when the settings change. Periods are counted in one **household time zone**, so two devices in different zones don't remake mixes on every request: the zone in Settings → Mixes, else the first device to ask (remembered), else the server's.

**Made in the background.** A check every minute walks the accounts one at a time and remakes whatever is due. Requests read what's stored and only wait when an account has no mixes yet; a due mix is served as it is while its replacement is made. Making them yields between mixes so the server keeps answering. Each summary says when it next changes (`refreshesAt`), and the web asks again then. Changing what the mixes are made of (which kinds, length, Discovery, Blast window, genre and decade counts) remakes them; recording history on or off doesn't.

**Covers** are drawn by the apps, not the server (`apps/web/src/components/Mixes.tsx` with `lib/mixOrbit.ts`; the iOS app's `MixOrbit.swift` does the same arithmetic): a wash of the mix's colour, one album cover as a big circle with a ring, up to three more as small circles, and the name. Each kind of mix has its own band of hues (`planHues`), so a shelf never repeats a colour; Vibes, Discovery and On Repeat blend the colours of their first two covers.

### Blending order (`packages/mix/src/blend.ts`)

`blendScore(a, b)` rates how well one song would mix into the next from tempo, key and energy (the formula is in [mixing.md](mixing.md#5-choosing-songs-that-blend-blendts)). `blendOrder` in `generators.ts` uses it: from the first song, a greedy walk to the song that blends best (another artist first), then up to 200 2-opt swaps (reversing a stretch when its ends blend better that way round), then any run of one artist broken up. How each mix uses it:

- **Flow** (Discovery, Blast from the past, Deep cuts, Fresh arrivals, Time machine): shuffled for a different start, then ordered to blend.
- **Smooth** (Vibes, genre mixes, Deep focus): energy rises then falls, in steps of 0.15, ordered to blend within each step. With energy known for under half the songs, it falls back to flow.
- **Energy boost** rises and **Wind down** settles, step by step, blending within each step.
- **On Repeat** (most played first) and **On this day** (oldest first) keep their own order.

---

## 4. Settings → Mixes (`MixesPanel.tsx`)

- **Your mixes**: a switch for each kind.
- **How they're made**: the time zone ("Use this device's"), songs per mix (25 / 50 / 75 / 100, default 50), Discovery Weekly (Familiar / Balanced / Adventurous, default Balanced), Blast from the past (not heard for a month / 3 / 6 months / a year, default 3 months), genre mixes and decade mixes (0–4 each, defaults 3 and 2).
- **Listening history**: Remember what's played, how many songs since when, and **Clear history** (the account's only; its mixes are made again from scratch).
- **ListenBrainz**: the account's link (section 7).
- **Sound**: a pointer to Settings → Analysis, whose *Analyse every song in the library* switch (stored with these settings as `analyzeLibrary`) measures every song's sound, so Energy boost, Wind down, Deep focus and Vibes go by sound rather than genre.

Admins change how mixes are made (`PUT /api/settings/mixes`); members see it read-only. The history and the ListenBrainz link are each account's own.

---

## 5. Radio and Feeling lucky

**Radio** (`POST /api/radio`, `Mixes.radio`) finds library songs like a few seeds. Each candidate scores on style (0.35), energy closeness (0.25), being a ListenBrainz neighbour of up to 5 seeds (0.3), how well its tempo and key blend with the seeds (0.3, the last seed counting as much as the rest together), sharing a seed's artist (+0.1) and a little chance. The best are taken (at most 2 per artist), spread out, and ordered to blend on from the last seed. It's used two ways (`apps/web/src/player/radio.ts`, iOS `Radio.swift`):

- **When the queue runs out**: as the last song starts, with repeat off, 25 songs like the last 5 heard are added, leaving out everything already queued. *Keep playing when the queue ends* (Settings → Playback, per device) turns it off.
- **Start radio** on a song: that song, then 25 like it, playing as "<song> radio".

**Feeling lucky** (`POST /api/lucky`, on Home) puts 15 songs together on the spot. The first suits the hour, scored as Vibes is but picked by chance among the best 16; one press in four wanders to a song not heard at this hour. The rest are radio from it. The server remembers each account's last 20 first songs and last 45 songs (in memory), so the next press goes elsewhere.

---

## 6. Jump back in, stats and the year in review

**Jump back in** (`GET /api/plays/recent-albums`): the albums of the most recent full plays, those the account can still hear, up to 12. Home hides the shelf with fewer than 3.

**Listening stats** (`GET /api/stats?range=`, `stats.ts`; the web page is `/settings/listening`) cover 4 weeks, 6 months, 12 months, all time, or any calendar year with plays. Skips don't count. For the period: minutes, plays, songs, artists, days listened, longest streak of days, artists heard for the first time, the top 10 artists and albums (by time heard) and songs (by plays), the top 6 genres (album genres weighted by time), minutes by hour of day and weekday, and for a year minutes by month and the first song of the year. Years and days are cut at midnight UTC; hours and weekdays are the devices' local ones.

**The year in review** is a calendar year's stats page, with the artist of the year. In December and January, Home shows a card for it ("Your 2026 in music").

---

## 7. ListenBrainz

**Scrobbling** (`apps/server/src/listenbrainz/scrobbler.ts`). Each account can link its own ListenBrainz account in Settings → Mixes with a user token, which the server checks with ListenBrainz and keeps (it is never sent back). From then on its plays are sent; *Also send N earlier plays* sends the history from before. Only plays heard for half the song or four minutes count as listens, as ListenBrainz asks; the rest are marked not to send. Listens go in batches of 100, every minute and after each new report, with the recording's MusicBrainz id when it has one. A refused token turns sending off with a message; ListenBrainz asking to slow down (or being unreachable) pauses for as long as it says, or 5 minutes.

**Tag lookup** (`Analyzer.fetchMeta`, `recordingTags`). Genre and mood tags, and the first release year, for every song the mixes see, 25 recordings per call to ListenBrainz's metadata endpoint, paced by its rate-limit headers. Tags weigh the recording's most, then the release group's (0.6), then the artist's (0.4); the top 16 are kept in `track_meta`. It is cheap, so it runs whether or not the whole library is being analysed; Settings → Analysis shows it as *tags*.

**Similar recordings** (labs `similar-recordings`, session-based, no key, each seed cached for an hour): recordings real listeners play in the same sessions. They feed Discovery Weekly, radio, and a playlist's recommendations. **Similar artists** (labs `similar-artists`, cached 6 hours) feed the "similar artists" on artist pages ([server/discover-and-requests.md](server/discover-and-requests.md)).

**Songs like these** (`apps/server/src/discover/recommendations.ts`, `GET /api/playlists/:id/recommendations`) is a playlist's recommendations from ListenBrainz. Up to 10 playlist songs are the seeds (evenly spread; *New mix* picks a random set and shakes up the ranking), each seed's matches are scaled to its best, and songs similar to several seeds rise. Songs already in the playlist go. Up to 10 library songs (3 per lead artist) and 20 missing ones (2 per artist) are kept; missing songs carry their release group so they can be requested. Requesting and the rest of Discover are in [server/discover-and-requests.md](server/discover-and-requests.md).

---

## 8. Routes

| Route | Who | What |
|---|---|---|
| `POST /api/plays` | any account | play reports, at most 500 at a time |
| `GET /api/plays/recent-albums` | any account | Jump back in |
| `GET /api/stats?range=` | any account | `month`, `halfyear`, `year`, `all` or a year |
| `POST /api/radio` | any account | `{ seeds, exclude?, count? }` |
| `POST /api/lucky?tz=` | any account | Feeling lucky |
| `GET /api/mixes?tz=`, `GET /api/mixes/:key?tz=` | any account | summaries, one mix with its songs |
| `POST /api/mixes/:key/regenerate`, `/save` | any account | New mix, save as a playlist |
| `GET /api/settings/mixes` | own | settings and the account's history count |
| `PUT /api/settings/mixes` | admin | change how mixes are made |
| `DELETE /api/settings/mixes/history` | own | clear the account's history |
| `GET/PUT/DELETE /api/settings/listenbrainz`, `POST …/earlier` | own | the account's ListenBrainz link |

*Own* means the account's own (from the home network only, before setup). The web and the iOS app send the device's time zone (`tz`) with mix requests; it only counts until the household has one. The wider API is in [server/api.md](server/api.md); how the apps show all this is in [web.md](web.md). Why the design is as it is: [decisions.md](decisions.md).

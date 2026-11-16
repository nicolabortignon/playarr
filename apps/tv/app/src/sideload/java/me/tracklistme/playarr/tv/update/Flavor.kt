package me.tracklistme.playarr.tv.update

import me.tracklistme.playarr.tv.PlayarrApp

/** The sideload flavor updates itself from GitHub releases. */
internal fun selfUpdate(app: PlayarrApp): SelfUpdate? = GitHubUpdates(app, app.http)

package me.tracklistme.playarr.tv.update

import kotlinx.coroutines.flow.StateFlow

/**
 * The app updating itself from GitHub releases (plan 9 §7), in the sideload flavor only: Google Play updates the play
 * flavor itself and doesn't allow an app to install packages, so there `PlayarrApp.updates` is null.
 */
interface SelfUpdate {
  val state: StateFlow<UpdateState>

  /** The app came to the front: asks GitHub if it hasn't for a day, and carries on an install waiting for permission. */
  fun resumed()

  /** Asks GitHub now (Settings → About). */
  fun check()

  /** Downloads the release found, checks it, and hands it to the TV's installer. */
  fun install()
}

sealed interface UpdateState {
  /** Not asked yet. */
  data object Unknown : UpdateState
  data object Checking : UpdateState
  /** Nothing newer than this app; [latest] is the newest release there is (null: none yet). */
  data class UpToDate(val latest: TvReleases.Release?) : UpdateState
  data class Available(val release: TvReleases.Release) : UpdateState
  data class Downloading(val release: TvReleases.Release, val percent: Int) : UpdateState
  /** The TV's "install unknown apps" isn't allowed for Playarr yet. */
  data class Allow(val release: TvReleases.Release) : UpdateState
  /** Handed to the TV's installer, which asks to confirm. */
  data class Installing(val release: TvReleases.Release) : UpdateState
  data class Failed(val message: String, val release: TvReleases.Release?) : UpdateState
}

/** The release an update state offers to install, if any. */
val UpdateState.release: TvReleases.Release?
  get() = when (this) {
    is UpdateState.Available -> release
    is UpdateState.Downloading -> release
    is UpdateState.Allow -> release
    is UpdateState.Installing -> release
    is UpdateState.Failed -> release
    else -> null
  }

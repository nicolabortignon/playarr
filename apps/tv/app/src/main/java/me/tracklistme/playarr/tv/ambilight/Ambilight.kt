package me.tracklistme.playarr.tv.ambilight

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import me.tracklistme.playarr.api.Track

/**
 * The Ambilight follows the music (plan 9 §6). While a song plays, the TV's lights take its cover's colors
 * (AmbilightColors), faded from one song to the next. Playarr takes the lights in manual mode and gives back the owner's
 * own mode and style half a minute after the music stops, or at once when the switch goes off. With the lights off,
 * they stay off. A TV that doesn't answer JointSpace says so in Settings, and the music carries on.
 */
class Ambilight(private val store: AmbilightStore, http: OkHttpClient, private val deviceName: String) {
  sealed interface Status {
    data object Off : Status
    data object Looking : Status
    /** No JointSpace at any of the TV's own addresses. */
    data object NotFound : Status
    /** The TV is showing a PIN. */
    data class Pin(val pairing: JointSpace.Pairing) : Status
    data object Ready : Status
    data class Failed(val message: String) : Status
  }

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val lock = Mutex()
  private val http = TvAddresses.client(http, FirstUseTrust(store::certificate, store::pinCertificate))
  private val state = MutableStateFlow<Status>(if (store.enabled.value) Status.Looking else Status.Off)
  val status: StateFlow<Status> = state.asStateFlow()
  val enabled: StateFlow<Boolean> get() = store.enabled

  private data class Saved(val mode: String?, val configuration: JsonObject?)
  private data class Playing(val track: Track?, val playing: Boolean)

  private var space: JointSpace? = null
  private var topology: Topology? = null
  /** The owner's mode and style, while Playarr holds the lights. */
  private var saved: Saved? = null
  private var shown: Sides? = null
  private var latest = Playing(null, false)
  private var lighting: Job? = null
  private var givingBack: Job? = null

  init {
    if (store.enabled.value) scope.launch { lock.withLock { connect() } }
  }

  // Settings.

  fun enable() {
    store.setEnabled(true)
    scope.launch {
      lock.withLock { connect() }
      follow(latest.track, latest.playing)
    }
  }

  @Synchronized
  fun disable() {
    store.setEnabled(false)
    lighting?.cancel()
    givingBack?.cancel()
    scope.launch { lock.withLock { giveBack() } }
    state.value = Status.Off
  }

  /** Asks the TV for a PIN again (pairing afresh). */
  fun pairAgain() {
    scope.launch {
      lock.withLock {
        giveBack()
        store.forget()
        space = null
        topology = null
        connect()
      }
    }
  }

  fun pair(pin: String) {
    val pairing = (state.value as? Status.Pin)?.pairing ?: return
    scope.launch {
      lock.withLock {
        val found = space ?: return@withLock
        try {
          store.credentials = found.pairGrant(pairing, pin.trim())
          space = found.signedIn(store.credentials)
          state.value = Status.Ready
        } catch (e: Exception) {
          state.value = Status.Failed("The TV didn’t take that PIN (${e.message}). Pair again for a new one.")
        }
      }
      follow(latest.track, latest.playing)
    }
  }

  // The player.

  /** The song playing now (null for none) and whether it plays; `fadeMs` over how long the lights change. */
  @Synchronized
  fun follow(track: Track?, playing: Boolean, fadeMs: Long = FADE_MS) {
    latest = Playing(track, playing)
    if (!store.enabled.value) return
    val target = track?.let { AmbilightColors.of(it.coverColor, it.coverAccent) }
    if (!playing || target == null) {
      if (givingBack?.isActive != true) givingBack = scope.launch {
        delay(GIVE_BACK_AFTER_MS)
        lock.withLock { giveBack() }
      }
      return
    }
    givingBack?.cancel()
    if (target == shown && lighting?.isActive != true) return
    lighting?.cancel()
    lighting = scope.launch { lock.withLock { light(target, fadeMs) } }
  }

  /** Playback is over (the service stopped): the owner's lights back now. */
  @Synchronized
  fun stopped() {
    latest = Playing(null, false)
    lighting?.cancel()
    givingBack?.cancel()
    scope.launch { lock.withLock { giveBack() } }
  }

  // Under the lock.

  private suspend fun connect() {
    state.value = Status.Looking
    try {
      val known = store.base?.toHttpUrlOrNull()?.let { JointSpace(it, http) }
      val found = known?.takeIf { runCatching { it.system() }.isSuccess } ?: JointSpace.find(http)
      if (found == null) {
        state.value = Status.NotFound
        return
      }
      store.base = found.base.toString()
      val signed = found.signedIn(store.credentials)
      if (signed.needsPairing()) {
        store.credentials = null
        space = found
        state.value = Status.Pin(found.pairRequest(JointSpace.Device(store.deviceId(), deviceName)))
      } else {
        space = signed
        state.value = Status.Ready
      }
    } catch (e: Exception) {
      Log.w(TAG, "JointSpace", e)
      state.value = Status.Failed(e.message ?: "The TV didn’t answer")
    }
  }

  private suspend fun light(target: Sides, fadeMs: Long) {
    if (state.value != Status.Ready) return
    val tv = space ?: return
    try {
      if (saved == null) {
        if (tv.power().equals("Off", ignoreCase = true)) return
        val mode = tv.mode()
        saved = Saved(mode, tv.configuration())
        topology = topology ?: tv.topology()
        tv.setMode("manual")
      }
      val sides = topology ?: return
      val from = shown ?: target
      val steps = (fadeMs / STEP_MS).toInt().coerceAtLeast(1)
      for (i in 1..steps) {
        val colors = from.mix(target, i / steps.toFloat())
        tv.show(colors, sides)
        shown = colors
        if (i < steps) delay(STEP_MS)
      }
    } catch (e: JointSpace.Failure) {
      Log.w(TAG, "Ambilight", e)
      if (e.status == 401) state.value = Status.Failed("The TV no longer knows Playarr. Pair again.")
    } catch (e: java.io.IOException) {
      Log.w(TAG, "Ambilight", e)
    }
  }

  private suspend fun giveBack() {
    val keep = saved ?: return
    saved = null
    shown = null
    val tv = space ?: return
    runCatching {
      // A mode left at manual (the app stopped while it held the lights) goes back to following the picture.
      tv.setMode(keep.mode?.takeIf { it != "manual" } ?: "internal")
      keep.configuration?.let { tv.setConfiguration(it) }
    }.onFailure { Log.w(TAG, "Giving the lights back", it) }
  }

  companion object {
    private const val TAG = "PlayarrAmbilight"
    const val FADE_MS = 1_500L
    /** Over a DJ transition, about as long as one. */
    const val TRANSITION_FADE_MS = 8_000L
    const val STEP_MS = 100L
    const val GIVE_BACK_AFTER_MS = 30_000L
  }
}

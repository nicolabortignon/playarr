package me.tracklistme.playarr.tv.ui.connect

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import me.tracklistme.playarr.api.Api
import me.tracklistme.playarr.api.ApiClient
import me.tracklistme.playarr.api.ApiError
import me.tracklistme.playarr.api.DeviceCodeStart
import me.tracklistme.playarr.api.DevicePoll
import me.tracklistme.playarr.api.DiscoveredServer
import me.tracklistme.playarr.api.ServerAddress
import me.tracklistme.playarr.api.ServerInfo
import me.tracklistme.playarr.tv.playarr

/**
 * Connecting the TV (plan 9 §2–3): find the server (Bonjour, or an address typed with the remote), then show a code
 * that someone signed in on a phone or the web approves, polling until they do. An expired code is replaced by a new
 * one without asking; a server nobody has set up says to set it up on a phone or computer first.
 */
class ConnectModel(application: Application) : AndroidViewModel(application) {
  private val app = application.playarr

  sealed interface Step {
    /** Choosing a server; `problem` says why the last one didn't work. */
    data class Finding(val problem: String? = null) : Step
    data class Connecting(val baseUrl: String) : Step
    /** Showing `code`; signed in once it's approved. */
    data class Code(val server: ServerInfo, val baseUrl: String, val code: DeviceCodeStart) : Step
    /** The server has no owner yet. */
    data class NeedsSetup(val server: ServerInfo, val baseUrl: String) : Step
    /** Approved: the account listens now. */
    data object SignedIn : Step
  }

  private val step = MutableStateFlow<Step>(Step.Finding())
  val current: StateFlow<Step> = step.asStateFlow()

  val servers: StateFlow<List<DiscoveredServer>> = app.browser.servers()
    .catch { emit(emptyList()) }
    .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

  private var job: Job? = null

  fun choose(server: DiscoveredServer) = connect(server.baseUrl)

  fun type(address: String) {
    val url = try {
      ServerAddress.url(address)
    } catch (e: ServerAddress.Rejected) {
      step.value = Step.Finding(e.problem.message)
      return
    }
    connect(url)
  }

  fun back() {
    job?.cancel()
    step.value = Step.Finding()
  }

  private fun connect(baseUrl: String) {
    job?.cancel()
    step.value = Step.Connecting(baseUrl)
    job = viewModelScope.launch {
      val client = ApiClient(baseUrl, http = app.http, timeoutMillis = 10_000)
      try {
        val info = client.send(Api.Server.info())
        if (info.setup) {
          step.value = Step.NeedsSetup(info, baseUrl)
          return@launch
        }
        signIn(client, info, baseUrl)
      } catch (e: ApiError) {
        step.value = Step.Finding(if (e is ApiError.Offline) "Nothing answered at $baseUrl. Check the address, and that the server is on." else e.message)
      }
    }
  }

  /** Codes, one after another as each expires, until one is approved. */
  private suspend fun signIn(client: ApiClient, info: ServerInfo, baseUrl: String) {
    while (true) {
      val code = client.send(Api.Auth.startDevice(app.device))
      step.value = Step.Code(info, baseUrl, code)
      while (true) {
        delay(code.interval * 1000L)
        when (val answer = runCatching { client.send(Api.Auth.pollDevice(code.pollToken)) }.getOrNull()) {
          is DevicePoll.Approved -> {
            app.store.signedIn(info, baseUrl, answer.account, answer.token)
            step.value = Step.SignedIn
            return
          }
          is DevicePoll.Expired -> break
          // Pending, a dead spot, or an answer this version doesn't know: ask again.
          else -> Unit
        }
      }
    }
  }
}

package me.tracklistme.playarr.tv.ui.common

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.State
import androidx.compose.runtime.produceState
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Text
import me.tracklistme.playarr.api.ApiClient
import me.tracklistme.playarr.api.ApiError
import me.tracklistme.playarr.tv.playarr
import me.tracklistme.playarr.tv.ui.theme.Palette
import me.tracklistme.playarr.tv.ui.theme.Type

/** Something asked of the server: on its way, here, or failed with what to tell the listener. */
sealed interface Load<out T> {
  data object Loading : Load<Nothing>
  data class Done<T>(val value: T) : Load<T>
  data class Failed(val message: String) : Load<Nothing>
}

/** Asks the listening account's server with `load`, again whenever a key changes. */
@Composable
fun <T> rememberLoad(vararg keys: Any?, load: suspend (ApiClient) -> T): State<Load<T>> {
  val app = LocalContext.current.playarr
  val store by app.store.current.collectAsState()
  return produceState<Load<T>>(Load.Loading, store.account?.id, *keys) {
    val client = app.client()
    value = if (client == null) Load.Failed("Not signed in") else try {
      Load.Done(load(client))
    } catch (e: ApiError) {
      Load.Failed(e.message ?: "Something went wrong")
    }
  }
}

/** `content` once loaded; a quiet line while loading, the error when it failed. */
@Composable
fun <T> Loaded(load: Load<T>, content: @Composable (T) -> Unit) {
  when (load) {
    is Load.Done -> content(load.value)
    is Load.Loading -> Box(Modifier.fillMaxWidth().padding(vertical = 24.dp)) { Text("Loading…", style = Type.meta) }
    is Load.Failed -> Box(Modifier.fillMaxWidth().padding(vertical = 24.dp)) { Text(load.message, style = Type.small.copy(color = Palette.danger)) }
  }
}

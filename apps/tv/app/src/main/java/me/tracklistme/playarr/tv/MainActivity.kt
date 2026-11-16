package me.tracklistme.playarr.tv

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import me.tracklistme.playarr.tv.ui.connect.ConnectScreen
import me.tracklistme.playarr.tv.ui.shell.Route
import me.tracklistme.playarr.tv.ui.shell.Shell
import me.tracklistme.playarr.tv.ui.theme.PlayarrTheme

/** One activity: connecting until someone has signed in, then the app; adding an account goes back to connecting. */
class MainActivity : ComponentActivity() {
  /** A page to open (`am start … --es route album:12`): screenshots now, the TV's links later. */
  private var opening by mutableStateOf<Route?>(null)

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    intent.getStringExtra(ROUTE)?.let { opening = Route.decode(it) }
  }

  override fun onResume() {
    super.onResume()
    playarr.updates?.resumed()
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val store = playarr.store
    opening = intent.getStringExtra(ROUTE)?.let(Route::decode)
    setContent {
      PlayarrTheme {
        val state by store.current.collectAsStateWithLifecycle()
        var adding by rememberSaveable { mutableStateOf(false) }
        val account = state.account
        if (state.server == null || account == null || adding) {
          ConnectScreen(onSignedIn = { adding = false }, onCancel = if (account != null) ({ adding = false }) else null)
        } else {
          Shell(account, onAddAccount = { adding = true }, opening = opening)
        }
      }
    }
  }

  private companion object {
    const val ROUTE = "route"
  }
}

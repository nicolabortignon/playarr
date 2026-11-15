package me.tracklistme.playarr.tv

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import me.tracklistme.playarr.tv.ui.connect.ConnectScreen
import me.tracklistme.playarr.tv.ui.home.HomeScreen
import me.tracklistme.playarr.tv.ui.theme.PlayarrTheme

/** One activity: connecting until someone has signed in, then the library; adding an account goes back to connecting. */
class MainActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val store = playarr.store
    setContent {
      PlayarrTheme {
        val state by store.current.collectAsStateWithLifecycle()
        var adding by rememberSaveable { mutableStateOf(false) }
        val server = state.server
        val account = state.account
        if (server == null || account == null || adding) {
          ConnectScreen(onSignedIn = { adding = false }, onCancel = if (account != null) ({ adding = false }) else null)
        } else {
          HomeScreen(
            account = account,
            others = server.accounts.filter { it.id != account.id },
            onSwitch = { store.switchTo(server.id, it.id) },
            onAddAccount = { adding = true },
            onSignOut = { store.signedOut(server.id, account.id) },
          )
        }
      }
    }
  }
}

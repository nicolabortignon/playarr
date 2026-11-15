package me.tracklistme.playarr.tv

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text

/** Step 1's app (plan 9): it installs, shows in the launcher with its banner, and says hello from the sofa. */
class MainActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContent {
      Column(
        modifier = Modifier.fillMaxSize().background(Ink),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
      ) {
        Text("Playarr", color = Paper, fontSize = 64.sp)
        Text("On the TV, version ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})", color = PaperDim, fontSize = 24.sp)
      }
    }
  }
}

private val Ink = Color(0xFF0F0E0C)
private val Paper = Color(0xFFECE6DC)
private val PaperDim = Color(0xFFB8B0A3)

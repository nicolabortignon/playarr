package me.tracklistme.playarr.tv.ui.connect

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import me.tracklistme.playarr.tv.ui.theme.Palette

/**
 * `text` as a QR code: ink modules on paper, the way round every phone camera reads, drawn one pixel per module and
 * scaled up without smoothing so the edges stay sharp.
 */
@Composable
fun QrCode(text: String, size: Dp, contentDescription: String, modifier: Modifier = Modifier) {
  val bitmap = remember(text) {
    val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0, mapOf(EncodeHintType.MARGIN to 0))
    val pixels = IntArray(matrix.width * matrix.height) { i ->
      if (matrix.get(i % matrix.width, i / matrix.width)) 0xFF0F0E0C.toInt() else 0xFFECE6DC.toInt()
    }
    Bitmap.createBitmap(pixels, matrix.width, matrix.height, Bitmap.Config.ARGB_8888).asImageBitmap()
  }
  Image(
    bitmap = bitmap,
    contentDescription = contentDescription,
    filterQuality = FilterQuality.None,
    modifier = modifier.background(Palette.paper, RoundedCornerShape(12.dp)).padding(16.dp).size(size),
  )
}

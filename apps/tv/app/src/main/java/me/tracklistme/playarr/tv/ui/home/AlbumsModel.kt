package me.tracklistme.playarr.tv.ui.home

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import me.tracklistme.playarr.api.Album
import me.tracklistme.playarr.api.AlbumSort
import me.tracklistme.playarr.api.Api
import me.tracklistme.playarr.api.ApiError
import me.tracklistme.playarr.tv.playarr

/** The library's albums, newest first, a page at a time (`/api/albums?offset=`, plan 3 §1). */
class AlbumsModel(application: Application) : AndroidViewModel(application) {
  private val app = application.playarr

  data class State(val albums: List<Album> = emptyList(), val total: Int? = null, val error: String? = null, val loading: Boolean = false)

  private val state = MutableStateFlow(State())
  val current: StateFlow<State> = state.asStateFlow()
  private var job: Job? = null

  init {
    more()
  }

  /** The next page, unless one is on its way or there's no more. */
  fun more() {
    val now = state.value
    if (job?.isActive == true || (now.total != null && now.albums.size >= now.total)) return
    val client = app.client() ?: return
    state.value = now.copy(loading = true, error = null)
    job = viewModelScope.launch {
      try {
        val page = client.send(Api.Library.albumPage(AlbumSort.Added, offset = now.albums.size, limit = PAGE)).page
        state.value = State(albums = now.albums + page.albums, total = page.total)
      } catch (e: ApiError) {
        state.value = now.copy(loading = false, error = e.message)
      }
    }
  }

  private companion object {
    const val PAGE = 60
  }
}

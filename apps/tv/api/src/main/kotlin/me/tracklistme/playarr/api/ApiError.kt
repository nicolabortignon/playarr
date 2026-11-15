package me.tracklistme.playarr.api

/** What can go wrong talking to a Playarr server (the iOS app's APIError). */
public sealed class ApiError(message: String) : Exception(message) {
  /** The session ended (signed out elsewhere, password reset): sign in again. */
  public data object Unauthorized : ApiError("You were signed out. Sign in again.")

  /** The server answered with an error status and its `{ error }` message; `retryAfter` from a 503's Retry-After, in seconds. */
  public data class Server(val status: Int, override val message: String, val retryAfter: Int? = null) : ApiError(message)

  /** The server couldn't be reached. */
  public data object Offline : ApiError("Can’t reach the server. Check the address and your connection.")

  /** The answer isn't what this version of the app expects. */
  public data class Decoding(val detail: String) : ApiError("The server sent an answer this version of Playarr doesn’t understand.")
}

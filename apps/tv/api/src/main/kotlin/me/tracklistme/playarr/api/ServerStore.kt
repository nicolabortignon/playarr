package me.tracklistme.playarr.api

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable

/** A server the TV knows, with the accounts signed in on it (the iOS app's ServerRecord). Tokens live in a SecretStore. */
@Serializable
public data class ServerRecord(
  val id: String,
  val name: String,
  val baseUrl: String,
  /** The server's home-network address when `baseUrl` is its public one. */
  val localUrl: String? = null,
  val accounts: List<AccountRecord> = emptyList(),
)

/** An account signed in on this TV: who listens, switched from the side menu. */
@Serializable
public data class AccountRecord(val id: Int, val name: String, val username: String)

/** Who's listening now: a server and one of its accounts. */
@Serializable
public data class Listening(val serverId: String, val accountId: Int)

/** Somewhere small to keep a string: the app's SharedPreferences, or a map in tests. */
public interface KeyValues {
  public fun get(key: String): String?
  public fun set(key: String, value: String?)
}

/**
 * The servers and accounts on this TV, and who's listening (the iOS app's ServerStore). Several accounts may be signed
 * in at once, as on the phone; the side menu switches between them. Records are kept as JSON in `values`, tokens in
 * `secrets`.
 */
public class ServerStore(private val values: KeyValues, private val secrets: SecretStore) {
  @Serializable
  public data class State(val servers: List<ServerRecord> = emptyList(), val listening: Listening? = null) {
    public val server: ServerRecord? get() = servers.firstOrNull { it.id == listening?.serverId }
    public val account: AccountRecord? get() = server?.accounts?.firstOrNull { it.id == listening?.accountId }
  }

  private val state = MutableStateFlow(load())
  public val current: StateFlow<State> = state.asStateFlow()

  /** Keeps a sign-in: the server (added, or its name and address brought up to date), the account and its token. */
  public fun signedIn(server: ServerInfo, baseUrl: String, account: Account, token: String, localUrl: String? = null) {
    secrets.set(tokenKey(server.id, account.id), token)
    val record = AccountRecord(account.id, account.name, account.username)
    update { s ->
      val existing = s.servers.firstOrNull { it.id == server.id }
      val accounts = (existing?.accounts.orEmpty().filter { it.id != account.id } + record).sortedBy { it.name.lowercase() }
      val updated = ServerRecord(server.id, server.name, baseUrl, localUrl ?: existing?.localUrl, accounts)
      s.copy(servers = s.servers.filter { it.id != server.id } + updated, listening = Listening(server.id, account.id))
    }
  }

  public fun token(serverId: String, accountId: Int): String? = secrets.get(tokenKey(serverId, accountId))

  /** Listens as another account signed in on this TV. */
  public fun switchTo(serverId: String, accountId: Int) {
    update { s -> if (s.servers.any { it.id == serverId && it.accounts.any { a -> a.id == accountId } }) s.copy(listening = Listening(serverId, accountId)) else s }
  }

  /** Forgets an account's sign-in (signed out here, or its session ended): another account listens, if there is one. */
  public fun signedOut(serverId: String, accountId: Int) {
    secrets.set(tokenKey(serverId, accountId), null)
    update { s ->
      val servers = s.servers.map { if (it.id == serverId) it.copy(accounts = it.accounts.filter { a -> a.id != accountId }) else it }
      val stillListening = s.listening?.takeUnless { it.serverId == serverId && it.accountId == accountId }
      val next = stillListening ?: servers.firstNotNullOfOrNull { server -> server.accounts.firstOrNull()?.let { Listening(server.id, it.id) } }
      s.copy(servers = servers, listening = next)
    }
  }

  /** The account's name changed on the server. */
  public fun refreshed(serverId: String, account: Account) {
    update { s ->
      s.copy(servers = s.servers.map { server ->
        if (server.id != serverId) server
        else server.copy(accounts = server.accounts.map { if (it.id == account.id) AccountRecord(account.id, account.name, account.username) else it })
      })
    }
  }

  private fun update(change: (State) -> State) {
    synchronized(this) {
      val next = change(state.value)
      values.set(KEY, ApiJson.writing.encodeToString(State.serializer(), next))
      state.value = next
    }
  }

  private fun load(): State = values.get(KEY)?.let { runCatching { ApiJson.reading.decodeFromString(State.serializer(), it) }.getOrNull() } ?: State()

  private companion object {
    const val KEY = "playarr.servers"
    fun tokenKey(serverId: String, accountId: Int) = "token:$serverId:$accountId"
  }
}

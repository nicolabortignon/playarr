/// What a panel shows for a call that failed: the server's `{ error }` message (APIError's description), or the system's.
func failureText(_ error: any Error) -> String {
  error.localizedDescription
}

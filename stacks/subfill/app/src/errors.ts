// An error that says a service is down, not that an item is bad. The worker
// puts the item back without counting an attempt, so an outage of Bazarr or
// Ollama never wears the backlog down to "failed".
export class Unavailable extends Error {}

// An error that says a service is down, not that an item is bad. The worker
// puts the item back without counting an attempt, so an outage of Bazarr or
// Ollama never wears the backlog down to "failed".
export class Unavailable extends Error {}

// The model started repeating itself and Ollama cut it off ("token repeat
// limit reached"). That is about the text it was given, not the machine:
// the translation splits the batch and tries smaller pieces, as for an
// answer that makes no sense.
export class ModelLooped extends Error {}

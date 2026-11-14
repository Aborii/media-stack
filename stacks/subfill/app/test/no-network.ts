// Loaded before every test file. Tests hand Bazarr, Ollama and the sign-in
// gate fake fetch functions; any test that reaches the real global fetch has
// forgotten to, and fails here instead of touching the network.
globalThis.fetch = (async (input: unknown) => {
  throw new Error(`a test tried to reach the network: ${String(input)}`);
}) as typeof fetch;

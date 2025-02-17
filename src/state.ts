interface DocState {
  rev: string,
  path: string, // without leading slash
  hashes: Map<string, string>, // by format, sha3-512
}

export default interface State {
  refreshToken?: string,
  cursor?: string,
  docs: Map<string, DocState>, // by id
}

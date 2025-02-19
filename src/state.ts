interface DocState {
  rev: string,
  path: string, // without leading slash
  hashes: Record<string, string>, // by format, sha3-512
}

interface Args {
  formats: string[],
  directory?: string,
}

export default interface State {
  refreshToken?: string,
  cursor?: string,
  docs: Record<string, DocState>, // by id
  args?: Args,
}

import { } from 'dropbox';

declare module 'dropbox' {
  interface RefreshTokenHolder {
    refresh_token: string,
  }

  interface Dropbox {
    rpcRequest<T>(path: string, args: unknown, auth: string, host: string): Promise<DropboxResponse<T>>;
    auth: DropboxAuth,
  }

  interface DropboxAuth {
    getAccessTokenFromCode(redirectUri: string, code: string): Promise<DropboxResponse<RefreshTokenHolder>>;
  }

  namespace files {
    interface ExportResult {
      fileBinary: Buffer;
    }
  }
}
import { Dropbox } from 'dropbox';

declare module 'dropbox' {
  interface Dropbox {
    rpcRequest(path: string, args: any, auth: string, host: string): Promise<any>;
  }
}
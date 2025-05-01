// Global type definitions for the window object
interface Window {
  nostrZap: any;
  nostr?: {
    getPublicKey: () => Promise<string>;
    signEvent: (event: any) => Promise<any>;
    getRelays: () => Promise<Record<string, {read: boolean, write: boolean}>>;
  };
} 
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import App from './App.svelte';

// Mock nostr-fetch and nostr-tools
vi.mock('nostr-fetch', () => {
  return {
    NostrFetcher: {
      init: () => ({
        fetchLatestEvents: vi.fn().mockResolvedValue([
          {
            id: '123abc',
            kind: 10002,
            created_at: 1677654321,
            tags: [
              ['r', 'wss://relay1.com', 'read'],
              ['r', 'wss://relay2.com', 'read'],
              ['r', 'wss://relay3.com', 'write']
            ],
            content: '',
            pubkey: 'abcd1234'
          }
        ]),
        allEventsIterator: vi.fn().mockImplementation(function* () {
          yield {
            id: 'event1',
            kind: 30166,
            created_at: 1677654321,
            tags: [['d', 'wss://discovered-relay.com']],
            content: '',
            pubkey: 'pubkey1'
          };
        })
      })
    }
  };
});

vi.mock('nostr-tools', () => {
  const mockEvent = {
    id: 'note123',
    kind: 1,
    created_at: 1677654321,
    tags: [],
    content: 'This is a test note',
    pubkey: 'abcd1234'
  };

  return {
    SimplePool: class {
      subscribeMany() {
        const sub = {
          close: vi.fn()
        };
        
        // Call onevent with the mock event
        setTimeout(() => {
          const handlers = arguments[2];
          if (handlers.onevent) {
            handlers.onevent.call({ url: 'wss://relay1.com' }, mockEvent);
            handlers.oneose.call({ url: 'wss://relay1.com' });
          }
        }, 10);
        
        return sub;
      }
    },
    Relay: class MockRelay {
      url: string;
      status: number;
      
      constructor(url: string) {
        this.url = url;
        this.status = 0;
      }
      
      connect() {
        this.status = 1;
        return Promise.resolve();
      }
      
      close() {
        this.status = 3;
      }
      
      subscribe() {
        return { close: vi.fn() };
      }
    },
    nip19: {
      decode: vi.fn().mockImplementation((value) => {
        if (value.startsWith('nevent1')) {
          return {
            type: 'nevent',
            data: {
              id: 'abcd1234',
              relays: ['wss://relay1.com']
            }
          };
        }
        throw new Error('Invalid NIP-19 value');
      })
    }
  };
});

// Mock the window.nostr object
const mockNostrExtension = {
  getPublicKey: vi.fn().mockResolvedValue('npub1abcdef123456789'),
  signEvent: vi.fn(),
  getRelays: vi.fn().mockResolvedValue({
    'wss://relay1.com': { read: true, write: true },
    'wss://relay2.com': { read: true, write: false }
  })
};

describe('Mode 2: Check Your Notes', () => {
  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();
    
    // Mock localStorage to set Mode 2 as active
    Storage.prototype.getItem = vi.fn((key) => {
      if (key === 'nadar_active_mode') return '2';
      return null;
    });
    
    Storage.prototype.setItem = vi.fn();
    
    // Mock window.matchMedia
    Object.defineProperty(window, 'matchMedia', {
      value: vi.fn().mockImplementation(query => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn()
      })),
      writable: true
    });
  });
  
  it('should show Mode 2 UI elements', async () => {
    // Simulate no NIP-07 extension
    Object.defineProperty(window, 'nostr', { value: undefined });
    
    render(App);
    
    // Check for the login button which appears when NIP-07 extension is available but not logged in
    const loginButton = screen.getByText('Login with Extension');
    expect(loginButton).toBeTruthy();
  });
  
  it('should be able to switch to Mode 1', async () => {
    // Simulate no NIP-07 extension 
    Object.defineProperty(window, 'nostr', { value: undefined });
    
    const { component } = render(App);
    
    // Get Mode 1 tab button
    const mode1Tab = screen.getByText('Find Note by ID');
    
    // Click on Mode 1 tab to switch modes
    await fireEvent.click(mode1Tab);
    
    // Should show Mode 1 input field
    expect(screen.getByPlaceholderText(/Enter nevent, naddr, or hex event ID/)).toBeTruthy();
  });
}); 
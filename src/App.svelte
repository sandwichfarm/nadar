<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import { NostrFetcher, type NostrEvent } from 'nostr-fetch';
import type { Event, Filter } from 'nostr-tools';
import { Relay } from 'nostr-tools';
import { SimplePool } from 'nostr-tools/pool';
import { nip19 } from 'nostr-tools';
import { get, writable, type Writable } from 'svelte/store';
import type { SubCloser } from 'nostr-tools/abstract-pool';
import * as Tone from 'tone';
// @ts-ignore - Ignore the missing types for canvas-confetti
import confetti from 'canvas-confetti';

const NSITE_PROVIDER = 'nsite.lol'
const STATIC_NPUB = 'npub1nadarndr8f0fra505suk85xhvgksqer2vnuqsjkvt2tfm7d0wakqhwlpf5'
const CLEARNET_ADDRESS = 'https://nadar.sandwich.farm'

// Default preferences
const DEFAULT_DISCOVERY_RELAYS = [
  'wss://relay.nostr.watch',
  'wss://relaypag.es',
  'wss://monitorlizard.nostr1.com'
];
const DEFAULT_USERMETA_RELAYS = [
  'wss://purplepag.es',
  'wss://user.kindpag.es',
  'wss://relay.nostr.band',
  'wss://relay.damus.io',
  'wss://nos.lol'
]
const DEFAULT_MAX_CONCURRENT_RELAYS = 21;
const DEFAULT_SOUND_ENABLED = false;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_THEME = 'system'; // 'light', 'dark', or 'system'
const DEFAULT_DEBUG = true;
const DEFAULT_ACTIVE_MODE = 1; // Default to Mode 1

// Load preferences from localStorage or use defaults
let DISCOVERY_RELAYS = JSON.parse(localStorage.getItem('nadar_discovery_relays') || JSON.stringify(DEFAULT_DISCOVERY_RELAYS));
let MAX_CONCURRENT_RELAYS = parseInt(localStorage.getItem('nadar_max_concurrent_relays') || DEFAULT_MAX_CONCURRENT_RELAYS.toString());
let soundEnabled = localStorage.getItem('nadar_sound_enabled') === 'true' || DEFAULT_SOUND_ENABLED;
let timeoutMs = parseInt(localStorage.getItem('nadar_timeout_ms') || DEFAULT_TIMEOUT_MS.toString());
let theme = localStorage.getItem('nadar_theme') || DEFAULT_THEME;
let debug = localStorage.getItem('nadar_debug') === 'true' || DEFAULT_DEBUG;
let activeMode = parseInt(localStorage.getItem('nadar_active_mode') || DEFAULT_ACTIVE_MODE.toString());

// Types 
type TargetEvent = {
  type: 'nevent' | 'naddr' | 'hex';
  id?: string;  // For nevent
  pubkey?: string;
  kind?: number;
  identifier?: string;  // For naddr
  relays?: string[];
};

// Add a type for notes with expanded property
type ExpandableNote = Event & {
  expanded?: boolean;
};

let loading = false;
let foundRelays: Writable<Set<string>> = writable(new Set());
let totalEvents = 0;
let startTime: number;
let targetEvent: TargetEvent | undefined;
let foundOnRelays = writable(new Set<string>());
let checkedRelays = writable(new Set<string>());
let inputValue = '';
let currentBatch: string[] = [];
let currentBatchIndex = 0;
let totalBatches = 0;
let isPaused = false;
let isSearching = false;
let inputError = '';
let activeRelays: Relay[] = [];
let activeSubscriptions: SubCloser[] = [];
const zapLoaded = writable(false);
let npub = window.location.href.match(/npub1[a-z0-9]{59}/)?.[1];
let isNsite = npub ? true : false;
let showPreferences = false;
let discoveryRelaysText = DISCOVERY_RELAYS.join('\n');
let discoveryRelaysModified = false;

let searchCompleted = false;
let searchStartTime: number;
let searchDuration = 0;
let synth: Tone.Synth;
let pingSound: Tone.Player;
let clickSound: Tone.Player;
let pageTurnSound: Tone.Player;

// Theme management
let systemDarkMode = false;

// Update theme based on system preference
function updateSystemTheme() {
  systemDarkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;
  updateTheme();
}

// Update theme based on current preference
function updateTheme() {
  const isDark = theme === 'dark' || (theme === 'system' && systemDarkMode);
  document.documentElement.classList.toggle('dark', isDark);
}

// Watch for system theme changes
onMount(() => {
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  mediaQuery.addEventListener('change', updateSystemTheme);
  updateSystemTheme();
  
  return () => {
    mediaQuery.removeEventListener('change', updateSystemTheme);
  };
});

// Create a custom debug logger that only logs when debug is enabled
function debugLog(...args: any[]) {
  if (debug) {
    console.log(...args);
  }
}

function debugError(...args: any[]) {
  if (debug) {
    console.error(...args);
  }
}

// Save preferences to localStorage
function savePreferences() {
  localStorage.setItem('nadar_discovery_relays', JSON.stringify(DISCOVERY_RELAYS));
  localStorage.setItem('nadar_max_concurrent_relays', MAX_CONCURRENT_RELAYS.toString());
  localStorage.setItem('nadar_sound_enabled', soundEnabled.toString());
  localStorage.setItem('nadar_timeout_ms', timeoutMs.toString());
  localStorage.setItem('nadar_theme', theme);
  localStorage.setItem('nadar_debug', debug.toString());
  localStorage.setItem('nadar_active_mode', activeMode.toString());
}

// Reset preferences to defaults
function resetPreferences() {
  DISCOVERY_RELAYS = [...DEFAULT_DISCOVERY_RELAYS];
  MAX_CONCURRENT_RELAYS = DEFAULT_MAX_CONCURRENT_RELAYS;
  soundEnabled = DEFAULT_SOUND_ENABLED;
  timeoutMs = DEFAULT_TIMEOUT_MS;
  theme = DEFAULT_THEME;
  debug = DEFAULT_DEBUG;
  activeMode = DEFAULT_ACTIVE_MODE;
  discoveryRelaysText = DISCOVERY_RELAYS.join('\n');
  savePreferences();
}

// Helper function to normalize relay URLs
function normalizeRelayUrl(url: string): string {
  try {
    // Remove trailing slashes and convert to lowercase
    return new URL(url).toString(); 
  } catch {
    return url;
  }
}

// Helper function to extract relay URLs from NIP-66 events
function extractRelayUrl(event: Event): string | undefined {
  let url = undefined;
  url = event.tags
    .find(tag => tag[0] === 'd')?.[1]
  if(url) {
    url = normalizeRelayUrl(url); 
  }
  return url;
}

async function discoverRelays() {
  loading = true;
  foundRelays.set(new Set());
  totalEvents = 0;
  startTime = Date.now();

  const fetcher = NostrFetcher.init();

  try {
    const nHoursAgo = (hrs: number): number =>
      Math.floor((Date.now() - hrs * 60 * 60 * 1000) / 1000);

    const eventIter = fetcher.allEventsIterator(
      DISCOVERY_RELAYS,
      { kinds: [30166] },
      { since: nHoursAgo(24) },
      { skipFilterMatching: true, skipVerification: true }
    );

    for await (const event of eventIter) {
      totalEvents++;
      const url = extractRelayUrl(event);
      if(!url) continue;
      foundRelays.update(relays => {
        relays.add(url);
        return relays;
      });
    }
  } catch (error) {
    debugError('Error discovering relays:', error);
  } finally {
    loading = false;
    // Ensure we have at least some relays even if discovery fails
    foundRelays.update(relays => {
      if (relays.size === 0) {
        // Add some fallback relays if discovery fails completely
        const fallbackRelays = [
          'wss://relay.damus.io',
          'wss://relay.nostr.band',
          'wss://nos.lol',
          'wss://relay.nostr.info'
        ];
        fallbackRelays.forEach(relay => relays.add(relay));
      }
      return relays;
    });
  }
}

async function cleanupActiveConnections() {
  // First close all subscriptions
  for (const sub of activeSubscriptions) {
    try {
      sub.close();
    } catch (error) {
      debugLog('Error closing subscription:', error);
    }
  }
  activeSubscriptions = [];

  // Then close all relay connections
  for (const relay of activeRelays) {
    try {
      // Only close if the connection is still open
      if ((relay as any).status === 1) {
        relay.close();
      }
    } catch (error) {
      debugLog('Error closing relay:', error);
    }
  }
  activeRelays = [];
}

function togglePause() {
  if (isPaused) {
    // Resume all active relays
    activeRelays.forEach(relay => {
      try {
        if ((relay as any).status === 3) { // CLOSED
          relay.connect();
        }
      } catch (error) {
        debugLog('Error resuming relay:', error);
      }
    });
  } else {
    // Pause all active relays
    activeRelays.forEach(relay => {
      try {
        if ((relay as any).status === 1) { // CONNECTED
          relay.close();
        }
      } catch (error) {
        debugLog('Error pausing relay:', error);
      }
    });
  }
  isPaused = !isPaused;
}

async function restartSearch() {
  // First stop the search
  isSearching = false;
  isPaused = false;

  // Reset state before cleanup to prevent any new events from being processed
  foundOnRelays.set(new Set());
  checkedRelays.set(new Set());
  targetEvent = undefined;
  inputError = '';
  currentBatch = [];
  currentBatchIndex = 0;

  // Then cleanup connections
  await cleanupActiveConnections();
}

async function showConfetti() {
  const canvas = document.createElement('canvas');
  canvas.style.position = 'fixed';
  canvas.style.top = '0';
  canvas.style.left = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.pointerEvents = 'none';
  canvas.style.zIndex = '9999';
  document.body.appendChild(canvas);

  const myConfetti = confetti.create(canvas, {
    resize: true,
    useWorker: true
  });

  // Fire confetti from the input field position
  const input = document.querySelector('input[type="text"]');
  if (input) {
    const rect = input.getBoundingClientRect();
    const x = (rect.left + rect.right) / 2 / window.innerWidth;
    const y = rect.bottom / window.innerHeight;

    myConfetti({
      particleCount: 100,
      spread: 70,
      origin: { x, y }
    });

    // Remove canvas after animation
    setTimeout(() => {
      canvas.remove();
    }, 5000);
  }
}

async function findEventOnRelays() {
  if (!targetEvent) return;
  
  // If already searching, stop the current search first
  if (isSearching) {
    await restartSearch();
  }
  
  // Clean up any existing connections first
  await cleanupActiveConnections();
  
  isSearching = true;
  isPaused = false;
  searchCompleted = false;
  searchStartTime = Date.now();
  foundOnRelays.set(new Set()); 
  checkedRelays.set(new Set());
  currentBatch = [];
  currentBatchIndex = 0;

  // Sort relays to prioritize those from the NIP-19 encoding
  const relayArray = [...get(foundRelays)];
  
  // Verify we have relays to search
  if (relayArray.length === 0) {
    debugError("No relays available to search");
    inputError = "No relays available. Please wait for relay discovery to complete.";
    isSearching = false;
    return;
  }
  
  const sortedRelays = relayArray.sort((a, b) => {
    const normalizedA = normalizeRelayUrl(a);
    const normalizedB = normalizeRelayUrl(b);
    const normalizedNip19Relays = targetEvent?.relays?.map(normalizeRelayUrl) || [];
    
    const aInNip19 = normalizedNip19Relays.includes(normalizedA);
    const bInNip19 = normalizedNip19Relays.includes(normalizedB);
    
    if (aInNip19 && !bInNip19) return -1;
    if (!aInNip19 && bInNip19) return 1;
    return 0;
  });

  // Double-check again after sorting
  if (sortedRelays.length === 0) {
    isSearching = false;
    searchCompleted = true;
    searchDuration = (Date.now() - searchStartTime) / 1000;
    inputError = "No relays to search.";
    return;
  }

  totalBatches = Math.ceil(sortedRelays.length / MAX_CONCURRENT_RELAYS);
  debugLog(`Starting search with ${sortedRelays.length} relays in ${totalBatches} batches`);

  // Create the appropriate filter based on the type
  const filter: Filter = targetEvent.type === 'nevent' || targetEvent.type === 'hex'
    ? { ids: [targetEvent.id!] }
    : {
        authors: [targetEvent.pubkey!],
        kinds: [targetEvent.kind!]
      };

  if(targetEvent?.identifier) {
    filter['#d'] = [targetEvent.identifier];
  }

  debugLog("Search filter:", filter);

  // Process relays in batches of MAX_CONCURRENT_RELAYS
  try {
    let previousBatchIndex = 0;
    let batchCount = 0;
    
    for (let i = 0; i < sortedRelays.length && isSearching; i += MAX_CONCURRENT_RELAYS) {
      batchCount++;
      if (isPaused) {
        await new Promise(resolve => {
          const checkPause = setInterval(() => {
            if (!isPaused) {
              clearInterval(checkPause);
              resolve(undefined);
            }
          }, 100);
        });
      }

      if (!isSearching) break;

      currentBatchIndex = Math.floor(i / MAX_CONCURRENT_RELAYS) + 1;
      debugLog(`Processing batch ${currentBatchIndex} of ${totalBatches}`);
      
      // Play page turn sound when changing batches
      if (soundEnabled && currentBatchIndex !== previousBatchIndex) {
        await playPageTurnSound();
        previousBatchIndex = currentBatchIndex;
      }
      
      currentBatch = sortedRelays.slice(i, i + MAX_CONCURRENT_RELAYS);
      debugLog(`Current batch has ${currentBatch.length} relays`);
      
      // Track if we've found a relay in this batch
      let foundRelayInCurrentBatch = false;

      // Process each relay in the batch with a small delay between connections
      const batchPromises = currentBatch.map(async (relayUrl, index) => {
        if (!isSearching) return null;

        // Add a small delay between connection attempts to avoid overwhelming the browser
        await new Promise(resolve => setTimeout(resolve, index * 50));
        debugLog(`Attempting to connect to relay: ${relayUrl}`);

        let relay: Relay | undefined;
        try {
          relay = new Relay(relayUrl);
          activeRelays.push(relay);
          
          debugLog(`Connecting to relay: ${relayUrl}`);
          const connectPromise = relay.connect();
          const connectTimeout = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Connection timeout')), 5000);
          });
          
          try {
            await Promise.race([connectPromise, connectTimeout]);
            debugLog(`Connected to relay: ${relayUrl}`);
          } catch (err) {
            debugError(`Connection failed to relay ${relayUrl}:`, err);
            throw err;
          }
          
          // Set up a timeout for the relay query
          const timeoutPromise = new Promise<null>((resolve) => {
            setTimeout(() => {
              debugLog(`Timeout reached for relay ${relayUrl}`);
              resolve(null);
            }, timeoutMs);
          });
          
          // Create a promise that resolves when we find the event on this relay
          const findPromise = new Promise<boolean>((resolve) => {
            if (!relay) {
              debugLog(`Relay object is undefined for ${relayUrl}`);
              return resolve(false);
            }
            
            debugLog(`Creating subscription for relay ${relayUrl} with filter:`, filter);
            const sub = relay.subscribe([filter], {
              onevent: (event) => {
                debugLog(`Event found on relay ${relayUrl}:`, event.id);
                const isFirstFound = !foundRelayInCurrentBatch;
                
                foundOnRelays.update(relays => {
                  relays.add(relayUrl);
                  return relays;
                });
                
                // Play radar sound on the first relay found in this batch
                if (soundEnabled && isFirstFound) {
                  foundRelayInCurrentBatch = true;
                  playRadarSound();
                }

                sub.close();
                resolve(true);
              },
              oneose: () => {
                debugLog(`EOSE received from relay ${relayUrl}`);
                sub.close();
                resolve(false);
              }
            });
            
            activeSubscriptions.push(sub);
          });
          
          // Race between finding the event and timing out
          debugLog(`Starting race for relay ${relayUrl}`);
          const found = await Promise.race([findPromise, timeoutPromise]);
          debugLog(`Race completed for relay ${relayUrl}, found: ${!!found}`);
          
          // Mark the relay as checked
          checkedRelays.update(relays => {
            relays.add(relayUrl);
            return relays;
          });
          
          return { relayUrl, success: true, found: !!found };
        } catch (error) {
          debugError(`Error with relay ${relayUrl}:`, error);
          
          // Ensure the relay is still marked as checked even if there was an error
          checkedRelays.update(relays => {
            relays.add(relayUrl);
            return relays;
          });
          
          return { relayUrl, success: false, found: false };
        } finally {
          if (relay) {
            try {
              debugLog(`Closing relay connection: ${relayUrl}`);
              relay.close();
              const index = activeRelays.indexOf(relay);
              if (index > -1) {
                activeRelays.splice(index, 1);
              }
            } catch (error) {
              debugError(`Error closing relay ${relayUrl}:`, error);
            }
          }
        }
      });

      // Wait for all batch promises to complete
      debugLog(`Waiting for all ${batchPromises.length} promises in batch ${currentBatchIndex} to complete`);
      const results = await Promise.allSettled(batchPromises);
      debugLog(`Batch ${currentBatchIndex} completed with ${results.length} results`);
      
      // Add a small delay between batches
      await new Promise(resolve => setTimeout(resolve, 100));

      // Check if we've completed all relays or if the search was cancelled
      if (get(checkedRelays).size >= sortedRelays.length || !isSearching) {
        debugLog("Search complete or cancelled");
        break;
      }
    }

    // Only complete if we weren't cancelled
    if (isSearching) {
      debugLog("Search completed successfully");
      currentBatch = [];
      currentBatchIndex = 0;
      isSearching = false;
      searchCompleted = true;
      searchDuration = (Date.now() - searchStartTime) / 1000;

      // Play completion sounds if enabled
      if (soundEnabled) {
        const foundCount = get(foundOnRelays).size;
        if (foundCount > 0) {
          await playSuccessSound();
        } else {
          await playFailureSound();
        }
      }

      // Show confetti if relays were found
      const foundCount = get(foundOnRelays).size;
      if (foundCount > 0) {
        showConfetti();
      }
    }
  } catch (error) {
    debugError('Error in search:', error);
    isSearching = false;
    searchCompleted = true;
    searchDuration = (Date.now() - searchStartTime) / 1000;
  }
}

// Extract nevent/naddr/hex from URL path
function extractSearchFromPath() {
  const path = window.location.pathname.slice(1); // Remove leading slash
  if (path.startsWith('nevent1') || path.startsWith('naddr1')) {
    return path;
  }
  // Check for hex ID in URL path
  const hexRegex = /^[0-9a-fA-F]{64}$/;
  if (hexRegex.test(path)) {
    return path;
  }
  return null;
}

// Process the nevent/naddr and start search
async function processSearch(value: string) {
  // Don't process if not in Mode 1
  if (activeMode !== 1) return;
  
  debugLog("processSearch called with:", value);
  if (!value) {
    debugLog("No search value provided");
    return;
  }

  inputError = '';
  
  // Check if the input is a hex ID (32 bytes / 64 hex characters)
  const hexRegex = /^[0-9a-fA-F]{64}$/;
  if (hexRegex.test(value)) {
    debugLog("Detected hex ID:", value);
    // Create target event for hex ID
    targetEvent = {
      type: 'hex',
      id: value.toLowerCase(),
      relays: []
    };
    
    debugLog("Target event set for hex ID:", targetEvent);
    // Reset search state before starting new search
    searchCompleted = false;
    isSearching = false;
    foundOnRelays.set(new Set());
    checkedRelays.set(new Set());
    currentBatch = [];
    currentBatchIndex = 0;
    
    // Force synchronous execution before starting search
    await new Promise(resolve => setTimeout(resolve, 0));
    
    debugLog("Starting search for hex ID...");
    // Start the search
    findEventOnRelays();
    return;
  }
  
  try {
    debugLog("Decoding NIP-19:", value);
    // Try to decode as nevent or naddr
    const decoded = nip19.decode(value);
    debugLog("Decoded:", decoded);
    
    if (decoded.type === 'nevent') {
      const data = decoded.data as { id: string; pubkey?: string; relays?: string[] };
      debugLog("Decoded as nevent:", data);
      targetEvent = {
        type: 'nevent',
        id: data.id,
        pubkey: data.pubkey,
        relays: data.relays?.map(normalizeRelayUrl) || []
      };
    } else if (decoded.type === 'naddr') {
      const data = decoded.data as { identifier: string; pubkey: string; kind: number; relays?: string[] };
      debugLog("Decoded as naddr:", data);
      targetEvent = {
        type: 'naddr',
        identifier: data.identifier,
        pubkey: data.pubkey,
        kind: data.kind,
        relays: data.relays?.map(normalizeRelayUrl) || []
      };
    } else {
      debugLog("Invalid type:", decoded.type);
      inputError = 'Input must be a nevent, naddr, or hex event ID';
      return;
    }
    
    debugLog("Target event set:", targetEvent);
    // Reset search state before starting new search
    searchCompleted = false;
    isSearching = false;
    foundOnRelays.set(new Set());
    checkedRelays.set(new Set());
    currentBatch = [];
    currentBatchIndex = 0;
    
    // Force synchronous execution before starting search
    await new Promise(resolve => setTimeout(resolve, 0));
    
    debugLog("Starting search now...");
    // Start the search
    findEventOnRelays();
    
  } catch (error) {
    debugError('Error in processSearch:', error);
    inputError = 'Invalid nevent, naddr, or hex event ID format';
  }
}

// Update the input handler to handle hex IDs
function handleInput(event: KeyboardEvent) {
  if (event.key === 'Enter') {
    const input = event.currentTarget as HTMLInputElement;
    const value = input.value.trim();
    processSearch(value);
    inputValue = value;
  }
}

onMount(async () => {
  // Start relay discovery
  discoverRelays();

  // Check for direct nevent/naddr in URL
  const searchValue = extractSearchFromPath();
  if (searchValue) {
    // Set the input value
    inputValue = searchValue;
    debugLog("Search value from URL:", searchValue);

    if (get(foundRelays).size > 0) {
      // If relays already loaded, search immediately
      debugLog("Relays already loaded, searching immediately");
      processSearch(searchValue);
    } else {
      debugLog("Waiting for relays to load before searching");
      // Wait for relays to be discovered before starting search
      const checkInterval = 500; // ms
      const maxAttempts = 120; // 60 seconds max
      let attempts = 0;
      
      const relayCheckInterval = setInterval(() => {
        attempts++;
        const relayCount = get(foundRelays).size;
        debugLog(`Relay check attempt ${attempts}: ${relayCount} relays found, loading=${loading}`);
        
        if (relayCount > 0 && !loading) {
          clearInterval(relayCheckInterval);
          debugLog(`Starting search with ${relayCount} relays`);
          // Process the search only after relays are available
          setTimeout(() => processSearch(searchValue), 100);
        } else if (attempts >= maxAttempts) {
          clearInterval(relayCheckInterval);
          debugLog("Timeout waiting for relays, attempting search anyway");
          setTimeout(() => processSearch(searchValue), 100);
        }
      }, checkInterval);
    }
  }

  import('https://cdn.jsdelivr.net/npm/nostr-zap@latest' as any).then(() => {
    zapLoaded.set(true);
  });
});

onMount(async () => {
  // Create reverb and delay effects for radar sound
  const reverb = new Tone.Reverb({
    decay: 2.5,
    wet: 0.4
  }).toDestination();
  
  const delay = new Tone.FeedbackDelay({
    delayTime: 0.2,
    feedback: 0.3,
    wet: 0.3
  }).connect(reverb);

  // Initialize Tone.js synth for radar sound with effects
  synth = new Tone.Synth({
    oscillator: {
      type: "sine"
    },
    envelope: {
      attack: 0.01,
      decay: 0.2,
      sustain: 0,
      release: 0.5
    }
  }).connect(delay);

  // Initialize ping sound for relay discovery
  pingSound = new Tone.Player({
    url: "https://cdn.freesound.org/previews/242/242856_4284968-lq.mp3",
    autostart: false,
    volume: -10
  }).toDestination();

  // Initialize click sound for relay found
  clickSound = new Tone.Player({
    url: "https://cdn.freesound.org/previews/242/242857_4284968-lq.mp3",
    autostart: false,
    volume: -15
  }).toDestination();

  await Tone.loaded();
});

// Sound effect functions
async function playRadarSound() {
  if (!soundEnabled) return;
  await Tone.start();
  
  // Create a more realistic sonar/radar sound
  const now = Tone.now();
  
  // First ping
  synth.triggerAttackRelease("A5", "32n", now);
  
  // Echo effect manually created with decreasing volume
  synth.volume.setValueAtTime(-15, now + 0.1);
  synth.triggerAttackRelease("A5", "32n", now + 0.1);
  
  synth.volume.setValueAtTime(-20, now + 0.2);
  synth.triggerAttackRelease("A5", "32n", now + 0.2);
  
  synth.volume.setValueAtTime(-25, now + 0.3);
  synth.triggerAttackRelease("A5", "32n", now + 0.3);
  
  // Reset volume
  synth.volume.setValueAtTime(0, now + 0.4);
}

async function playPageTurnSound() {
  if (!soundEnabled) return;
  await Tone.start();
  
  // Create a paper-like rustling sound
  const now = Tone.now();
  
  // Quick ascending notes with decreasing volume for paper rustle effect
  synth.volume.setValueAtTime(-10, now);
  synth.triggerAttackRelease("G4", "32n", now);
  
  synth.volume.setValueAtTime(-15, now + 0.05);
  synth.triggerAttackRelease("A4", "32n", now + 0.05);
  
  synth.volume.setValueAtTime(-20, now + 0.1);
  synth.triggerAttackRelease("B4", "32n", now + 0.1);
  
  // Reset volume
  synth.volume.setValueAtTime(0, now + 0.15);
}

async function playFoundSound() {
  if (!soundEnabled) return;
  await Tone.start();
  clickSound.start();
}

async function playSuccessSound() {
  if (!soundEnabled) return;
  await Tone.start();
  const now = Tone.now();
  synth.triggerAttackRelease("C4", "8n", now);
  synth.triggerAttackRelease("E4", "8n", now + 0.1);
  synth.triggerAttackRelease("G4", "8n", now + 0.2);
  synth.triggerAttackRelease("C5", "4n", now + 0.3);
}

async function playFailureSound() {
  if (!soundEnabled) return;
  await Tone.start();
  const now = Tone.now();
  synth.triggerAttackRelease("C4", "8n", now);
  synth.triggerAttackRelease("B3", "8n", now + 0.1);
  synth.triggerAttackRelease("Bb3", "8n", now + 0.2);
  synth.triggerAttackRelease("A3", "4n", now + 0.3);
}

// Clean up function
onDestroy(() => {
  zapLoaded.set(false);
  (window as any).nostrZap = undefined;
  if (synth) synth.dispose();
  if (pingSound) pingSound.dispose();
  if (clickSound) clickSound.dispose();
});

$: alternateLink = isNsite ? CLEARNET_ADDRESS : `https://${STATIC_NPUB}.${NSITE_PROVIDER}`

// Mode 2: NIP-07 Extension & NIP-65 variables
let loggedIn = false;
let currentPubkey = '';
let userRelays: Writable<string[]> = writable([]);
let recentNotes: ExpandableNote[] = [];
let loadingNotes = false;
let noteRelayMap: Map<string, Set<string>> = new Map(); // Maps note IDs to the relays they were found on
let noteSubscriptions: SubCloser[] = [];
let currentlyCheckingNoteId: string | null = null;
let totalNotesChecked = 0;
let isCurrentlyChecking = false;

// Check if NIP-07 extension is available
function hasNip07Extension(): boolean {
  return typeof window !== 'undefined' && 'nostr' in window;
}

// Login with NIP-07 extension
async function loginWithExtension() {
  if (!hasNip07Extension()) {
    debugError('NIP-07 extension not found');
    return;
  }
  
  try {
    // Access nostr through window object with type checking
    const nostr = (window as any).nostr;
    if (!nostr || typeof nostr.getPublicKey !== 'function') {
      debugError('Invalid NIP-07 extension');
      return;
    }
    
    currentPubkey = await nostr.getPublicKey();
    loggedIn = !!currentPubkey;
    
    if (loggedIn) {
      // Get user relays from NIP-07 extension
      const extensionRelays = typeof nostr.getRelays === 'function' 
        ? await nostr.getRelays() 
        : {};
      debugLog('Relays from extension:', extensionRelays);
      
      // Now fetch user's NIP-65 relays (kind:10002)
      await fetchUserRelays();
    }
  } catch (error) {
    debugError('Error logging in with extension:', error);
    loggedIn = false;
  }
}

// Fix the fetchUserRelays function syntax
async function fetchUserRelays() {
  if (!currentPubkey) return;
  
  debugLog('Fetching relays for pubkey:', currentPubkey);
  const _userRelays: string[] = [];

  const pool = new SimplePool();

  try {
    const sub = pool.subscribeMany(
      DEFAULT_USERMETA_RELAYS, 
      [{
        kinds: [10002],
        authors: [currentPubkey]
      }], 
      {
        onevent: (event: NostrEvent) => {
          debugLog('Found NIP-65 event:', event);
            
          // Extract relay URLs from the event tags
          for (const tag of event.tags) {
            if (tag[0] === 'r') {
              try {
                const url = new URL(tag[1]).toString();
                console.log('url', url);
                // const readPermission = tag[2] !== 'write'; // If not explicitly write-only
                
                // if (readPermission && url) {
                if(url) {
                  _userRelays.push(normalizeRelayUrl(url));
                }
                console.log('userRelays', userRelays);
              } catch (error) {
                debugError('Invalid relay URL:', tag[1]);
              }
            }
          }
          userRelays.set(_userRelays);
        },
        oneose: () => {
          debugLog('EOSE received for relay list');
          // No relays found after oneose, leave the list empty
          // Do not fallback to discovered relays as requested
          if (_userRelays.length === 0) {
            debugLog('No relays found in NIP-65 event, not using fallback');
          }
        }
      }
    );
    
    // Set a timeout to close the subscription after 5 seconds
    setTimeout(() => {
      try {
        sub.close();
      } catch (e) {
        debugError('Error closing subscription:', e);
      }
    }, 5000);
  } catch (error) {
    debugError('Error in fetchUserRelays:', error);
  }
}

// Fetch recent notes from user's relays
async function fetchRecentNotes(limit: number = 20) {
  if ($userRelays.length === 0) return;
  
  loadingNotes = true;
  recentNotes = [];
  noteRelayMap.clear();
  
  try {
    // Close any existing subscriptions
    for (const sub of noteSubscriptions) {
      try {
        sub.close();
      } catch (error) {
        debugLog('Error closing subscription:', error);
      }
    }
    noteSubscriptions = [];
    
    const pool = new SimplePool();
    const now = Math.floor(Date.now() / 1000);
    
    // Define subscription handler with proper typings
    type SubHandler = {
      onevent: (event: Event) => void;
      oneose: () => void;
      url?: string; // URL property that comes from the relay
    };
    
    debugLog('Fetching recent notes from relays:', $userRelays);
    
    // Use individual relay connections to gather notes
    const allNotes: Record<string, ExpandableNote> = {};
    const maxRelaysPerBatch = Math.min(MAX_CONCURRENT_RELAYS, 20); // Ensure no more than 20 concurrent relays
    
    // Process relays in batches to avoid overwhelming the browser
    for (let i = 0; i < $userRelays.length; i += maxRelaysPerBatch) {
      const batchRelays = $userRelays.slice(i, i + maxRelaysPerBatch);
      debugLog(`Processing relay batch for notes: ${batchRelays.length} relays`);
      
      // Set up connections to all relays in this batch
      const relayConnections: Relay[] = [];
      const subscriptions: SubCloser[] = [];
      
      for (const relayUrl of batchRelays) {
        try {
          const relay = new Relay(relayUrl);
          await relay.connect();
          relayConnections.push(relay);
          
          // Create subscription for this relay
          const sub = relay.subscribe(
            [{ 
              kinds: [1],
              authors: [currentPubkey],
              limit: limit
            }],
            {
              onevent(event) {
                debugLog(`Note ${event.id} found on relay ${relayUrl}`);
                
                // Add to notes if not already there
                if (!allNotes[event.id]) {
                  allNotes[event.id] = {
                    ...event,
                    expanded: false
                  } as ExpandableNote;
                }
                
                // Track which relay this note was found on
                if (!noteRelayMap.has(event.id)) {
                  noteRelayMap.set(event.id, new Set());
                }
                noteRelayMap.get(event.id)?.add(relayUrl);
              },
              oneose() {
                debugLog(`EOSE received from relay ${relayUrl}`);
              }
            }
          );
          
          subscriptions.push(sub);
          noteSubscriptions.push(sub);
        } catch (error) {
          debugError(`Error connecting to relay ${relayUrl}:`, error);
        }
      }
      
      // Wait for a moment to let subscriptions collect data
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Close connections for this batch
      for (const relay of relayConnections) {
        try {
          relay.close();
        } catch (error) {
          debugError(`Error closing relay connection:`, error);
        }
      }
    }
    
    // Convert collected notes to array and sort
    recentNotes = Object.values(allNotes).sort((a, b) => b.created_at - a.created_at);
    debugLog(`Found ${recentNotes.length} notes from ${$userRelays.length} relays`);
    
  } catch (error) {
    debugError('Error fetching recent notes:', error);
  } finally {
    loadingNotes = false;
  }
}

// Check a specific note against a list of relays (similar to Mode 1 approach)
async function checkNoteOnRelays(noteId: string, relayUrls: string[]) {
  debugLog(`Checking note ${noteId} on ${relayUrls.length} relays`);
  
  // Clean up any existing connections first
  await cleanupActiveConnections();
  
  // Create the filter for this note
  const filter: Filter = { ids: [noteId] };

  // Process relays in batches to avoid overwhelming the browser
  const MAX_CONCURRENT = Math.min(MAX_CONCURRENT_RELAYS, 20); // Ensure no more than 20 concurrent relays
  
  for (let i = 0; i < relayUrls.length && isSearching; i += MAX_CONCURRENT) {
    if (isPaused) {
      await new Promise(resolve => {
        const checkPause = setInterval(() => {
          if (!isPaused) {
            clearInterval(checkPause);
            resolve(undefined);
          }
        }, 100);
      });
    }

    if (!isSearching) break;

    // Get the current batch of relays
    const currentBatch = relayUrls.slice(i, i + MAX_CONCURRENT);
    debugLog(`Processing relay batch for note ${noteId}: ${currentBatch.length} relays`);
    
    // Track if we've found a relay in this batch (for sound effects)
    let foundRelayInCurrentBatch = false;
    
    // Process each relay in the batch
    const batchPromises = currentBatch.map(async (relayUrl, index) => {
      if (!isSearching) return null;

      // Add a small delay between connection attempts
      await new Promise(resolve => setTimeout(resolve, index * 50));
      
      let relay: Relay | undefined;
      try {
        relay = new Relay(relayUrl);
        activeRelays.push(relay);
        
        // Connect to the relay
        const connectPromise = relay.connect();
        const connectTimeout = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Connection timeout')), 5000);
        });
        
        try {
          await Promise.race([connectPromise, connectTimeout]);
        } catch (err) {
          debugError(`Connection failed to relay ${relayUrl}:`, err);
          throw err;
        }
        
        // Set up a timeout for the relay query
        const timeoutPromise = new Promise<null>((resolve) => {
          setTimeout(() => {
            debugLog(`Timeout reached for relay ${relayUrl}`);
            resolve(null);
          }, timeoutMs);
        });
        
        // Create a promise that resolves when we find the event on this relay
        const findPromise = new Promise<boolean>((resolve) => {
          if (!relay) {
            return resolve(false);
          }
          
          const sub = relay.subscribe([filter], {
            onevent: (event) => {
              debugLog(`Note ${noteId} found on relay ${relayUrl}`);
              
              foundOnRelays.update(relays => {
                relays.add(relayUrl);
                return relays;
              });
              
              // Play click sound when a relay is found
              if (soundEnabled && !foundRelayInCurrentBatch) {
                foundRelayInCurrentBatch = true;
                playFoundSound();
              }
              
              sub.close();
              resolve(true);
            },
            oneose: () => {
              debugLog(`EOSE received from relay ${relayUrl} for note ${noteId}`);
              sub.close();
              resolve(false);
            }
          });
          
          activeSubscriptions.push(sub);
        });
        
        // Race between finding the event and timing out
        const found = await Promise.race([findPromise, timeoutPromise]);
        
        // Mark the relay as checked
        checkedRelays.update(relays => {
          relays.add(relayUrl);
          return relays;
        });
        
        return { relayUrl, success: true, found: !!found };
      } catch (error) {
        debugError(`Error with relay ${relayUrl}:`, error);
        
        // Ensure the relay is still marked as checked even if there was an error
        checkedRelays.update(relays => {
          relays.add(relayUrl);
          return relays;
        });
        
        return { relayUrl, success: false, found: false };
      } finally {
        if (relay) {
          try {
            relay.close();
            const index = activeRelays.indexOf(relay);
            if (index > -1) {
              activeRelays.splice(index, 1);
            }
          } catch (error) {
            debugError(`Error closing relay ${relayUrl}:`, error);
          }
        }
      }
    });

    // Wait for all batch promises to complete
    await Promise.allSettled(batchPromises);
    
    // Add a small delay between batches
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

// Switch between modes
function switchMode(mode: number) {
  if (mode === activeMode) return;
  
  // Don't allow switching modes when either one is busy
  if (isSearching || loadingNotes) {
    return;
  }
  
  // Clean up current mode
  if (isSearching) {
    restartSearch();
  }
  
  activeMode = mode;
  savePreferences();
  
  // Initialize new mode
  if (mode === 2 && hasNip07Extension() && !loggedIn) {
    loginWithExtension();
  }
}

// Add variables and functions for note batch checking
let noteFetchCount = 20; // Default number of notes to fetch

// Update the fetchAndCheckNotes function to properly check relays
async function fetchAndCheckNotes(limit: number = 20) {
  if ($userRelays.length === 0) return;
  
  loadingNotes = true;
  recentNotes = [];
  noteRelayMap.clear();
  totalNotesChecked = 0;
  currentlyCheckingNoteId = null;
  isCurrentlyChecking = false;
  
  try {
    // First fetch the notes
    await fetchRecentNotes(limit);
    
    // Then check all notes against each relay
    if (recentNotes.length > 0) {
      debugLog(`Found ${recentNotes.length} notes, checking them on all relays`);
      isSearching = true;
      await checkAllNotesInBatches();
    }
  } catch (error) {
    debugError('Error in fetch and check notes:', error);
  } finally {
    loadingNotes = false;
    currentlyCheckingNoteId = null;
    isCurrentlyChecking = false;
  }
}

// Check all notes in batches of 5
async function checkAllNotesInBatches() {
  if (recentNotes.length === 0 || $userRelays.length === 0) return;
  
  const BATCH_SIZE = 1; // Process 1 note at a time for better UX
  const batchCount = Math.ceil(recentNotes.length / BATCH_SIZE);
  
  isSearching = true;
  searchStartTime = Date.now();
  
  try {
    for (let batchIndex = 0; batchIndex < batchCount && isSearching; batchIndex++) {
      // Get the current batch of notes
      const noteBatch = recentNotes.slice(batchIndex * BATCH_SIZE, (batchIndex + 1) * BATCH_SIZE);
      
      // Process each note in the batch
      for (const note of noteBatch) {
        if (!isSearching) break;
        
        debugLog(`Processing note ${note.id}`);
        
        // Set current note as being checked and expand it
        currentlyCheckingNoteId = note.id;
        isCurrentlyChecking = true;
        note.expanded = true;
        
        // Play the radar sound when starting to check a new note
        if (soundEnabled) {
          await playRadarSound();
        }
        
        // Set up the target event for this note
        targetEvent = {
          type: 'hex',
          id: note.id,
          relays: $userRelays
        };
        
        // Reset state for this note
        foundOnRelays.set(new Set());
        checkedRelays.set(new Set());
        
        // Check all relays for this note individually (similar to findEventOnRelays but targeted)
        await checkNoteOnRelays(note.id, $userRelays);
        
        // Store the results in the noteRelayMap
        noteRelayMap.set(note.id, new Set(get(foundOnRelays)));
        
        // Increment the number of checked notes
        totalNotesChecked++;
        
        // Play success sound if note was found on all relays, otherwise play partial success sound
        if (soundEnabled) {
          const foundRelaysCount = get(foundOnRelays).size;
          if (foundRelaysCount === $userRelays.length) {
            await playSuccessSound();
          } else if (foundRelaysCount > 0) {
            await playFoundSound();
          } else {
            await playFailureSound();
          }
        }
        
        // Keep note expanded for a moment so user can see the results
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Collapse the note if not the last one
        if (batchIndex < batchCount - 1) {
          note.expanded = false;
        }
        
        isCurrentlyChecking = false;
      }
    }
  } catch (error) {
    debugError('Error checking notes in batches:', error);
  } finally {
    isSearching = false;
    searchCompleted = true;
    searchDuration = (Date.now() - searchStartTime) / 1000;
    currentlyCheckingNoteId = null;
    isCurrentlyChecking = false;
  }
}

</script>

<div class="min-h-screen w-full bg-white dark:bg-gray-900">
<main class="container mx-auto p-4 relative dark:bg-gray-900 dark:text-white min-h-screen">
  <div class="flex flex-col sm:flex-row items-center gap-4 mb-4">
    <div class="flex items-center gap-4">
      {#if isSearching}
      <div class="radar"></div>
      {:else}
      <div class="radar-noanimation"></div>
      {/if}
      <!-- <img src="/nadar.png" class="h-16 w-auto" alt="NADAR 2.0" /> -->
      <h1 class="text-6xl font-bold">NADAR <small class="opacity-50">2.0</small></h1>
    </div>

    {#if zapLoaded}
      <div class="flex flex-wrap gap-2 sm:ml-auto">
        <button
          class="bg-gray-600 hover:bg-gray-700 text-white px-4 py-2 text-sm flex items-center gap-2"
          on:click={() => {
            soundEnabled = !soundEnabled;
            if (soundEnabled) {
              // Initialize audio context with a user gesture
              Tone.start();
            }
            savePreferences();
          }}>
          {#if soundEnabled}
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
            </svg>
          {:else}
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M17.25 9.75L19.5 12m0 0l2.25 2.25M19.5 12l2.25-2.25M19.5 12l-2.25 2.25m-10.5-6l4.72-4.72a.75.75 0 011.28.531V19.94a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.506-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
            </svg>
          {/if}
        </button>
        <button
          class="bg-gray-600 hover:bg-gray-700 text-white px-4 py-2 text-sm flex items-center gap-2"
          on:click={() => {
            theme = theme === 'dark' ? 'light' : 'dark';
            updateTheme();
            savePreferences();
          }}>
          {#if theme === 'dark' || (theme === 'system' && systemDarkMode)}
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
            </svg>
          {:else}
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
            </svg>
          {/if}
        </button>
        <a 
          href="https://github.com/sandwichfarm/nadar"
          target="_blank"
          class="bg-gray-600 text-white px-4 py-2 text-sm">
          github
        </a>
        {#if isNsite}
        <a 
          href="{alternateLink}"
          target="_blank"
          class="bg-gray-600 text-white px-4 py-2 text-sm">
          clearnet
        </a>
        {:else}
        <a 
          href="{alternateLink}"
          target="_blank"
          class="bg-purple-600 text-white px-4 py-2 text-sm">
          nsite
        </a>
        {/if}
        <button
          class="bg-orange-600 text-white px-4 py-2 text-sm"
          data-npub="npub1nadarndr8f0fra505suk85xhvgksqer2vnuqsjkvt2tfm7d0wakqhwlpf5"
          data-relays="wss://purplepag.es,wss://user.kindpag.es,wss://lunchbox.sandwich.farm,wss://nostrue.com,wss://relay.damus.io,wss://relay.nostr.band,wss://relay.primal.net,wss://wheat.happytavern.co">
          zap ⚡️
        </button>
      </div>
    {/if}
  </div>

  <!-- Mode Switcher Tabs -->
  <div class="flex mb-6 border-b dark:border-gray-700">
    <button
      class="px-4 py-2 font-medium {activeMode === 1 ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400' : 'text-gray-600 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400'} disabled:opacity-50 disabled:cursor-not-allowed"
      on:click={() => switchMode(1)}
      disabled={isSearching || loadingNotes}
    >
      Find Note by ID
    </button>
    <button
      class="px-4 py-2 font-medium {activeMode === 2 ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400' : 'text-gray-600 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400'} disabled:opacity-50 disabled:cursor-not-allowed"
      on:click={() => switchMode(2)}
      disabled={isSearching || loadingNotes}
    >
      Check Your Notes
    </button>
  </div>

  {#if showPreferences}
    <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div class="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-2xl w-full mx-4 relative">
        <button
          class="absolute top-2 right-2 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          on:click={() => showPreferences = false}
        >
          ✕
        </button>
        
        <h2 class="text-xl font-semibold mb-4 dark:text-white">Preferences</h2>
        
        <div class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1" for="discoveryRelays">
              NIP-66 Discovery Relays
            </label>
            <textarea
              id="discoveryRelays"
              class="w-full h-24 p-2 border rounded font-mono text-sm dark:bg-gray-800 dark:border-gray-700 dark:text-white disabled:opacity-75 disabled:bg-gray-100 dark:disabled:bg-gray-900"
              bind:value={discoveryRelaysText}
              disabled={isSearching}
              on:change={(e) => {
                const newRelays = e.currentTarget.value
                  .split('\n')
                  .map(r => r.trim())
                  .filter(r => r);
                
                // Check if relays have actually changed
                if (JSON.stringify(newRelays) !== JSON.stringify(DISCOVERY_RELAYS)) {
                  DISCOVERY_RELAYS = newRelays;
                  discoveryRelaysText = DISCOVERY_RELAYS.join('\n');
                  discoveryRelaysModified = true;
                  savePreferences();
                } else {
                  discoveryRelaysModified = false;
                }
              }}
            />
            <p class="text-sm text-gray-500 mt-1">One relay URL per line {isSearching ? '(disabled during search)' : ''}</p>
          </div>

          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1" for="maxConcurrentRelays">
              Max Concurrent Relays
            </label>
            <input
              type="number"
              id="maxConcurrentRelays"
              min="1"
              max="100"
              class="w-full p-2 border rounded dark:bg-gray-800 dark:border-gray-700 dark:text-white"
              bind:value={MAX_CONCURRENT_RELAYS}
              on:change={(e) => {
                MAX_CONCURRENT_RELAYS = parseInt(e.currentTarget.value);
                savePreferences();
              }}
            />
            <p class="text-sm text-gray-500 mt-1">Number of relays to query simultaneously (1-100)</p>
          </div>

          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1" for="relayTimeout">
              Relay Query Timeout (ms)
            </label>
            <input
              type="number"
              id="relayTimeout"
              min="1000"
              max="30000"
              step="1000"
              class="w-full p-2 border rounded dark:bg-gray-800 dark:border-gray-700 dark:text-white"
              bind:value={timeoutMs}
              on:change={(e) => {
                timeoutMs = parseInt(e.currentTarget.value);
                savePreferences();
              }}
            />
            <p class="text-sm text-gray-500 mt-1">Maximum time to wait for each relay (1000-30000ms)</p>
          </div>

          <div class="flex items-center">
            <input
              type="checkbox"
              id="soundEnabled"
              class="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded dark:border-gray-600 dark:bg-gray-700 dark:ring-offset-gray-800"
              bind:checked={soundEnabled}
              on:change={() => {
                if (soundEnabled) {
                  Tone.start();
                }
                savePreferences();
              }}
            />
            <label for="soundEnabled" class="ml-2 block text-sm text-gray-700 dark:text-gray-300">
              Enable Sound Effects
            </label>
          </div>

          <div class="flex items-center">
            <input
              type="checkbox"
              id="debugEnabled"
              class="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded dark:border-gray-600 dark:bg-gray-700 dark:ring-offset-gray-800"
              bind:checked={debug}
              on:change={() => {
                savePreferences();
              }}
            />
            <label for="debugEnabled" class="ml-2 block text-sm text-gray-700 dark:text-gray-300">
              Enable Debug Logging
            </label>
          </div>

          <div>
            <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1" for="themeSelect">
              Theme
            </label>
            <select
              id="themeSelect"
              class="w-full p-2 border rounded bg-white dark:bg-gray-800 dark:border-gray-700 dark:text-white"
              bind:value={theme}
              on:change={() => {
                updateTheme();
                savePreferences();
              }}
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </div>

          <div class="flex justify-end gap-2 mt-6">
            <button
              class="px-4 py-2 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
              on:click={() => {
                resetPreferences();
                discoveryRelaysModified = false;
              }}
            >
              Reset to Defaults
            </button>
            <button
              class="px-4 py-2 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 dark:bg-blue-600 dark:hover:bg-blue-700"
              on:click={() => {
                showPreferences = false;
                if (discoveryRelaysModified) {
                  discoverRelays();
                  discoveryRelaysModified = false;
                }
              }}
            >
              {discoveryRelaysModified ? 'Save & Rediscover' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  {/if}

  <!-- about section -->
  <div class="bg-gray-800/10 dark:bg-gray-700/10 mb-4 rounded-lg p-4">
    <p class="text-gray-700 dark:text-gray-300">
      NADAR 2.0 is a tool for finding specific notes on nostr. 
      It discovers relays using <a href="https://github.com/nostr-protocol/nips/blob/master/66.md" class="border-b border-gray-700">NIP-66</a>.
      This is a rewrite by 
      <a href="https://njump.me/npub1uac67zc9er54ln0kl6e4qp2y6ta3enfcg7ywnayshvlw9r5w6ehsqq99rx" target="_blank" class="border-b border-gray-700">sandwich</a> 
      of the <a href="https://nadar.tigerville.no/" target="_blank" class="border-b border-gray-700">original NADAR</a> by 
      <a href="https://njump.me/npub16ema6x3r8x8pe32lwnsll0krqmy79h5vvap8sdd7q5yhy4q2dv6slt6le9" target="_blank" class="border-b border-gray-700">Thorwegian</a>.
    </p>
  </div>

  <div class="bg-gray-800/10 dark:bg-gray-700/10 mb-4 rounded-lg p-4">
    <p class="text-gray-700 dark:text-gray-300">
      Hint: Add a <code>nevent</code>, <code>naddr</code>, or <code>hex event ID</code> to the path to automatically initiate a search 
      <a 
      href="/nevent1qqsyrn5mc5x6wlw624p0qgphpmxzkptd3u47j0quahcm74l0e2cftvqpp4mhxue69uhkummn9ekx7mqpyfmhxue69uhhqatjwpkx2urpvuhx2ue0y5erqur4wfcxcetsv9njuetnqyf8wumn8ghj7ur4wfcxcetsv9njuetnqy0hwumn8ghj7ur4wfcxcetsv9njuetn9acxzcnvdanrw73wvdhk6q3qtfrzlfsyfd9cmgcc229xnpaytcadlqet68ryh453p6k0an0sw4qslpmhr3" 
      target="_blank" 
      class="opacity-50 italic border-b border-gray-700">
        example</a>
    </p>
  </div>

  <div class="mb-4">
    <p class="text-gray-600">
      {#if loading}
        Searching for relays... 
      {/if}
      Found {$foundRelays.size} unique relays from {totalEvents} reports
      {#if !loading}
        in {(Date.now() - startTime) / 1000} seconds
      {/if}
    </p>
  </div>

  <!-- MODE 1: Find Note by ID -->
  {#if activeMode === 1}
    <div class="mb-4 relative">
      <input
        type="text"
        placeholder={loading ? "Please wait while relays are being loaded..." : "Enter nevent, naddr, or hex event ID"}
        class="p-2 border rounded w-full dark:bg-gray-800 dark:border-gray-700 dark:text-white {inputError ? 'border-red-500' : ''}"
        on:keydown={handleInput}
        disabled={isSearching || loading}
        value={inputValue}
      />
      <button
        class="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full backdrop-blur-sm bg-white/70 dark:bg-gray-800/70 text-gray-600 hover:text-gray-800 hover:bg-white/90 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-800/90 transition-all"
        title="Preferences"
        on:click={() => showPreferences = !showPreferences}>
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
          <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </button>
      {#if inputError}
        <p class="text-red-500 text-sm mt-1">{inputError}</p>
      {/if}
    </div>

    <div class="bg-gray-800/10 dark:bg-gray-700/10 mb-4 rounded-lg p-4">
      <p class="text-gray-700 dark:text-gray-300">
        Hint: Add a <code>nevent</code>, <code>naddr</code>, or <code>hex event ID</code> to the path to automatically initiate a search 
        <a 
        href="/nevent1qqsyrn5mc5x6wlw624p0qgphpmxzkptd3u47j0quahcm74l0e2cftvqpp4mhxue69uhkummn9ekx7mqpyfmhxue69uhhqatjwpkx2urpvuhx2ue0y5erqur4wfcxcetsv9njuetnqyf8wumn8ghj7ur4wfcxcetsv9njuetnqy0hwumn8ghj7ur4wfcxcetsv9njuetn9acxzcnvdanrw73wvdhk6q3qtfrzlfsyfd9cmgcc229xnpaytcadlqet68ryh453p6k0an0sw4qslpmhr3" 
      target="_blank" 
      class="opacity-50 italic border-b border-gray-700">
        example</a>
      </p>
    </div>

    {#if targetEvent}
      {#if searchCompleted}
        <div class="mb-4">
          <div class="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4 mb-4">
            <div class="flex items-center gap-2">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-6 h-6 text-green-600 dark:text-green-400">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <h2 class="text-xl font-semibold text-green-800 dark:text-green-400">Search Complete!</h2>
            </div>
            <div class="mt-2 text-green-700 dark:text-green-300">
              Search completed in {searchDuration.toFixed(1)} seconds
            </div>
          </div>

          <h2 class="text-xl font-semibold mb-2">Search Results:</h2>
          <div class="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-4 space-y-2">
            <div class="grid grid-cols-2 gap-4">
              <div>
                <span class="text-gray-600 dark:text-gray-400">Total Relays Searched:</span>
                <span class="ml-2 font-semibold">{$checkedRelays.size}</span>
              </div>
              <div>
                <span class="text-gray-600 dark:text-gray-400">Found On:</span>
                <span class="ml-2 font-semibold">{$foundOnRelays.size} relays</span>
              </div>
              <div>
                <span class="text-gray-600 dark:text-gray-400">Success Rate:</span>
                <span class="ml-2 font-semibold">
                  {($foundOnRelays.size / $checkedRelays.size * 100).toFixed(1)}%
                </span>
              </div>
              <div>
                <span class="text-gray-600 dark:text-gray-400">Time Taken:</span>
                <span class="ml-2 font-semibold">{searchDuration.toFixed(1)}s</span>
              </div>
            </div>
          </div>
        </div>
      {/if}

      {#if isSearching}
        <div class="mb-4">
          <h2 class="text-xl font-semibold mb-2">Search Progress:</h2>
          <div class="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-4 space-y-2">
            <div class="grid grid-cols-2 gap-2">
              <div>
                <span class="text-gray-600 dark:text-gray-400">Total Relays:</span>
                <span class="ml-2">{$foundRelays.size}</span>
              </div>
              <div>
                <span class="text-gray-600 dark:text-gray-400">Checked Relays:</span>
                <span class="ml-2">{$checkedRelays.size}</span>
              </div>
              <div>
                <span class="text-gray-600 dark:text-gray-400">Found On:</span>
                <span class="ml-2">{$foundOnRelays.size}</span>
              </div>
              <div>
                <span class="text-gray-600 dark:text-gray-400">Remaining:</span>
                <span class="ml-2">{$foundRelays.size - $checkedRelays.size}</span>
              </div>
            </div>
          </div>
        </div>
      {/if}

      <div class="mb-4">
        <h2 class="text-xl font-semibold mb-2">Search Details:</h2>
        <div class="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-4 space-y-2">
            <div>
              <span class="text-gray-600 dark:text-gray-400">Type:</span>
              <span class="font-mono ml-2">{targetEvent.type}</span>
            </div>
            <div class="flex items-center">
              <span class="text-gray-600 dark:text-gray-400">ID:</span>
              <span class="font-mono ml-2 text-sm break-all flex-1">{targetEvent.id}</span>
              {#if targetEvent.id}
              <button
                class="ml-2 p-1.5 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
                title="Copy ID"
                on:click={() => {
                  if (targetEvent?.id) {
                    navigator.clipboard.writeText(targetEvent.id);
                  }
                }}>
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                </svg>
              </button>
              {/if}
            </div>
            {#if targetEvent.pubkey}
              <div>
                <span class="text-gray-600 dark:text-gray-400">Pubkey:</span>
                <span class="font-mono ml-2 text-sm break-all">{targetEvent.pubkey}</span>
              </div>
            {/if}
            {#if targetEvent.type !== 'hex'}
              <div>
                <span class="text-gray-600 dark:text-gray-400">Relays from NIP-19:</span>
                <span class="ml-2">{targetEvent.relays?.length || 0}</span>
              </div>
            {/if}
        </div>
      </div>

      {#if !searchCompleted}
      <div class="flex gap-2 my-4">
        <button
          class="px-4 py-2 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 dark:bg-blue-600 dark:hover:bg-blue-700"
          on:click={togglePause}
          disabled={!isSearching}
        >
          {isPaused ? 'Resume' : 'Pause'}
        </button>
        <button
          class="px-4 py-2 text-sm bg-red-500 text-white rounded hover:bg-red-600 disabled:opacity-50"
          on:click={restartSearch}
          disabled={!isSearching}
        >
          Restart
        </button>
      </div>
      {/if}
      
      <div class="mb-4">
        {#if !searchCompleted}
        <h2 class="text-xl font-semibold mb-2">Searching for event:</h2>
        <p class="font-mono text-sm">{targetEvent.id}</p>
        {/if}
        
        {#if !searchCompleted && currentBatch.length > 0}
          <div class="mt-4">
            <div class="flex items-center gap-2 mb-2">
              <div class="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
                <div 
                  class="h-full bg-blue-500 transition-all duration-300"
                  style="width: {(currentBatchIndex / totalBatches) * 100}%"
                ></div>
              </div>
              <span class="text-sm text-gray-600">Batch {currentBatchIndex}/{totalBatches}</span>
            </div>
            <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-1">
              {#each currentBatch as relay}
                <div class="p-1.5 rounded text-xs font-mono truncate hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-1
                  {$foundOnRelays.has(relay) 
                    ? 'bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400' 
                    : $checkedRelays.has(relay) 
                      ? 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400' 
                      : 'bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300'}">
                  <span class="w-1.5 h-1.5 rounded-full 
                    {$foundOnRelays.has(relay) && targetEvent.relays?.includes(relay) ? 'bg-green-500' : ''}
                    {!$foundOnRelays.has(relay) && targetEvent.relays?.includes(relay) ? 'bg-red-500' : ''}
                    "></span>
                  {relay}
                </div>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    {/if}
  {:else if activeMode === 2}
    <!-- MODE 2: Check Your Notes -->
    <div class="mb-4">
      {#if !hasNip07Extension()}
        <div class="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4 mb-4">
          <div class="flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-6 h-6 text-yellow-600 dark:text-yellow-400">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
            </svg>
            <h2 class="text-xl font-semibold text-yellow-800 dark:text-yellow-400">NIP-07 Extension Required</h2>
          </div>
          <div class="mt-2 text-yellow-700 dark:text-yellow-300">
            To use Mode 2, you need a NIP-07 compatible browser extension like 
            <a href="https://getalby.com/" target="_blank" class="underline">Alby</a> or 
            <a href="https://github.com/fiatjaf/nos2x" target="_blank" class="underline">nos2x</a>.
          </div>
        </div>
      {:else if !loggedIn}
        <button
          class="w-full p-4 bg-blue-500 hover:bg-blue-600 text-white rounded-lg font-medium flex items-center justify-center gap-2"
          on:click={loginWithExtension}
        >
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
          </svg>
          Login with Extension
        </button>
      {:else}
        <!-- User Info & Controls -->
        <div class="bg-gray-800/10 dark:bg-gray-700/10 rounded-lg p-4 mb-4">
          <div class="flex items-center justify-between mb-3">
            <div>
              <span class="text-sm text-gray-700 dark:text-gray-300">Logged in as:</span>
              <span class="ml-2 font-mono text-sm text-gray-800 dark:text-gray-200">
                {currentPubkey ? `${currentPubkey.substring(0, 8)}...${currentPubkey.substring(currentPubkey.length - 8)}` : 'Not logged in'}
              </span>
            </div>
            <button
              class="px-3 py-1 text-sm bg-blue-500 hover:bg-blue-600 text-white rounded"
              on:click={fetchUserRelays}
            >
              Refresh Relays
            </button>
          </div>
          
          <div class="flex justify-between items-center">
            <span class="text-gray-700 dark:text-gray-300 font-semibold text-sm">Your Relays ({$userRelays.length})</span>
            
            <div class="flex items-center gap-2">
              <label for="noteCountInput" class="text-xs text-gray-600 dark:text-gray-400">Notes to fetch:</label>
              <input
                id="noteCountInput"
                type="number"
                class="w-16 p-1 text-sm border rounded dark:bg-gray-800 dark:border-gray-700 dark:text-white"
                min="5"
                max="100"
                step="5"
                bind:value={noteFetchCount}
              />
              <button
                class="px-3 py-1 text-sm bg-green-500 hover:bg-green-600 text-white rounded disabled:opacity-50"
                on:click={() => fetchAndCheckNotes(noteFetchCount)}
                disabled={loadingNotes || $userRelays.length === 0 || isSearching}
              >
                {loadingNotes || isSearching ? 'Working...' : 'Fetch & Check'}
              </button>
            </div>
          </div>
          
          <div class="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-1">
            {#each $userRelays as relay}
              <div class="text-xs font-mono truncate bg-gray-100 dark:bg-gray-800 p-1 rounded">
                {relay}
              </div>
            {/each}
          </div>
        </div>
        
        {#if isSearching}
          <!-- Search Progress Display - similar to Mode 1 -->
          <div class="mb-4">
            <h2 class="text-xl font-semibold mb-2">Checking Notes on Relays:</h2>
            <div class="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-4 space-y-2">
              <div class="grid grid-cols-2 gap-2">
                <div>
                  <span class="text-gray-600 dark:text-gray-400">Total Notes:</span>
                  <span class="ml-2">{recentNotes.length}</span>
                </div>
                <div>
                  <span class="text-gray-600 dark:text-gray-400">Your Relays:</span>
                  <span class="ml-2">{$userRelays.length}</span>
                </div>
                <div>
                  <span class="text-gray-600 dark:text-gray-400">Progress:</span>
                  <span class="ml-2">{noteRelayMap.size}/{recentNotes.length} notes</span>
                </div>
                <div>
                  <span class="text-gray-600 dark:text-gray-400">Current Note:</span>
                  <span class="ml-2 font-mono">{targetEvent?.id ? targetEvent.id.substring(0, 8) + '...' : 'None'}</span>
                </div>
              </div>
              
              {#if targetEvent}
                <div class="mt-2">
                  <div class="flex items-center gap-2 mb-2">
                    <div class="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
                      <div 
                        class="h-full bg-blue-500 transition-all duration-300"
                        style="width: {(noteRelayMap.size / recentNotes.length) * 100}%"
                      ></div>
                    </div>
                    <span class="text-sm text-gray-600">
                      {noteRelayMap.size}/{recentNotes.length} checked
                    </span>
                  </div>
                </div>
              {/if}
            </div>
          </div>
        {/if}
        
        {#if searchCompleted && recentNotes.length > 0}
          <!-- Final Report - after all checks are done -->
          <div class="mb-4">
            <div class="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4 mb-4">
              <div class="flex items-center gap-2">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-6 h-6 text-green-600 dark:text-green-400">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <h2 class="text-xl font-semibold text-green-800 dark:text-green-400">Check Complete!</h2>
              </div>
              <div class="mt-2 text-green-700 dark:text-green-300">
                Checked {recentNotes.length} notes on {$userRelays.length} relays in {searchDuration.toFixed(1)} seconds
              </div>
            </div>
            
            <!-- Summary Statistics -->
            <div class="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-4 mb-4">
              <h3 class="text-lg font-semibold mb-2">Results Summary:</h3>
              <div class="grid grid-cols-2 gap-4">
                <div>
                  <span class="text-gray-600 dark:text-gray-400">Total Notes:</span>
                  <span class="ml-2 font-semibold">{recentNotes.length}</span>
                </div>
                <div>
                  <span class="text-gray-600 dark:text-gray-400">Relays Checked:</span>
                  <span class="ml-2 font-semibold">{$userRelays.length}</span>
                </div>
                <div>
                  <span class="text-gray-600 dark:text-gray-400">Fully Synced Notes:</span>
                  <span class="ml-2 font-semibold">
                    {recentNotes.filter(note => noteRelayMap.get(note.id)?.size === $userRelays.length).length}
                  </span>
                </div>
                <div>
                  <span class="text-gray-600 dark:text-gray-400">Average Coverage:</span>
                  <span class="ml-2 font-semibold">
                    {(recentNotes.reduce((acc, note) => acc + (noteRelayMap.get(note.id)?.size || 0), 0) / (recentNotes.length * $userRelays.length) * 100).toFixed(1)}%
                  </span>
                </div>
              </div>
            </div>
          </div>
        {/if}
        
        <!-- Notes Display -->
        {#if recentNotes.length > 0}
          <div class="bg-gray-50 dark:bg-gray-800 border dark:border-gray-700 rounded-lg shadow-sm mb-4">
            <div class="p-3 border-b dark:border-gray-700 font-medium flex justify-between items-center">
              <span>Notes ({recentNotes.length})</span>
            </div>
            <div class="divide-y dark:divide-gray-700">
              {#each recentNotes as note}
                {@const relayCount = noteRelayMap.get(note.id)?.size || 0}
                {@const relayPercentage = Math.round((relayCount / $userRelays.length) * 100)}
                {@const statusColor = relayPercentage === 100 ? 'bg-green-500' : 
                                     relayPercentage > 66 ? 'bg-yellow-500' : 
                                     relayPercentage > 33 ? 'bg-orange-500' : 'bg-red-500'}
                {@const isChecking = currentlyCheckingNoteId === note.id}
                
                <div class="p-2.5 hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-all duration-300 {isChecking ? 'bg-blue-50 dark:bg-blue-900/30 border-l-4 border-blue-500' : ''}">
                  <div class="flex justify-between items-center mb-1.5">
                    <div class="font-mono text-xs text-gray-500 dark:text-gray-400 flex items-center">
                      <span class="mr-2">{note.id.substring(0, 8)}...</span>
                      <span class="text-xs text-gray-400 dark:text-gray-500">{new Date(note.created_at * 1000).toLocaleString()}</span>
                      {#if isChecking}
                        <span class="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300">
                          <svg class="animate-spin -ml-0.5 mr-1.5 h-2 w-2 text-blue-700 dark:text-blue-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                          Checking
                        </span>
                      {/if}
                    </div>
                    <div class="flex items-center gap-1.5">
                      <div class="flex items-center space-x-1">
                        <div class="w-2 h-2 rounded-full {isChecking ? 'animate-pulse bg-blue-500' : statusColor}"></div>
                        <span class="text-xs font-medium">
                          {relayCount}/{$userRelays.length} relays
                        </span>
                      </div>
                      <button
                        class="text-xs px-1.5 py-0.5 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 rounded"
                        on:click={() => note.expanded = !note.expanded}
                        disabled={isCurrentlyChecking && note.id !== currentlyCheckingNoteId}
                      >
                        {note.expanded ? 'Hide' : 'Details'}
                      </button>
                    </div>
                  </div>
                  
                  <div class="mt-1 text-sm line-clamp-2 {isChecking ? 'text-blue-800 dark:text-blue-300 font-medium' : ''}">
                    {note.content.substring(0, 150)}
                    {note.content.length > 150 ? '...' : ''}
                  </div>
                  
                  {#if note.expanded}
                    <div class="mt-2 bg-gray-100 dark:bg-gray-800 p-2 rounded-md {isChecking ? 'border border-blue-300 dark:border-blue-700' : ''}">
                      <div class="text-xs font-medium mb-1 flex justify-between">
                        <span>Relay Status:</span>
                        {#if isChecking}
                          <span class="text-blue-600 dark:text-blue-400 animate-pulse">Scanning relays...</span>
                        {/if}
                      </div>
                      <div class="grid grid-cols-1 sm:grid-cols-2 gap-1">
                        {#each $userRelays as relay}
                          {@const isFound = noteRelayMap.get(note.id)?.has(relay) || false}
                          {@const isPending = isChecking && !get(checkedRelays).has(relay)}
                          <div class="flex items-center gap-1 text-xs p-1 rounded 
                            {isFound ? 'bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400' : 
                             isPending ? 'bg-gray-50 dark:bg-gray-900 text-gray-500 dark:text-gray-400' : 
                             'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400'}">
                            {#if isPending}
                              <div class="w-1.5 h-1.5 rounded-full bg-gray-400 animate-pulse"></div>
                            {:else}
                              <div class="w-1.5 h-1.5 rounded-full {isFound ? 'bg-green-500' : 'bg-red-500'}"></div>
                            {/if}
                            <span class="font-mono truncate">{relay}</span>
                          </div>
                        {/each}
                      </div>
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        {/if}
      {/if}
    </div>
  {/if}

  {#if $foundOnRelays.size > 0}
    <div class="mb-4">
      <h2 class="text-xl font-semibold mb-2">Found on {$foundOnRelays.size} relays:</h2>
      <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-1">
        {#each [...$foundOnRelays].sort() as relay}
          <div class="p-1.5 bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded shadow text-xs font-mono truncate hover:bg-green-100 dark:hover:bg-green-900/50 flex items-center gap-1">
            <span class="w-1.5 h-1.5 rounded-full 
            {targetEvent && targetEvent.relays && $foundOnRelays.has(relay) && targetEvent.relays.includes(relay) ? 'bg-green-500' : ''}"></span>
            {relay}
          </div>
        {/each}
      </div>

      <div class="mt-4">
        <h3 class="text-sm font-semibold text-gray-600 dark:text-gray-400 mb-2">Copy relays as...</h3>
        <div class="flex gap-2">
          <button
            class="px-3 py-1.5 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-sm"
            on:click={() => {
              const relays = [...$foundOnRelays].sort();
              navigator.clipboard.writeText(relays.join('\n'));
            }}
          >
            Newline list
          </button>
          <button
            class="px-3 py-1.5 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-sm"
            on:click={() => {
              const relays = [...$foundOnRelays].sort();
              navigator.clipboard.writeText(relays.join(', '));
            }}
          >
            Comma list
          </button>
          <button
            class="px-3 py-1.5 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-sm"
            on:click={() => {
              const relays = [...$foundOnRelays].sort();
              navigator.clipboard.writeText(JSON.stringify(relays, null, 2));
            }}
          >
            JSON array
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Keep progress visible at bottom of screen -->
  {#if isSearching && recentNotes.length > 0}
    <div class="fixed bottom-0 left-0 right-0 bg-blue-50 dark:bg-blue-900/70 p-2 shadow-lg border-t border-blue-200 dark:border-blue-800 z-10">
      <div class="container mx-auto max-w-3xl">
        <div class="flex items-center justify-between">
          <div class="font-medium text-blue-800 dark:text-blue-300">
            Note {totalNotesChecked}/{recentNotes.length}
          </div>
          <div class="text-sm text-blue-700 dark:text-blue-400">
            {#if currentlyCheckingNoteId}
              Checking: {currentlyCheckingNoteId.substring(0, 8)}...
            {/if}
            
            {#if get(checkedRelays).size > 0 && $userRelays.length > 0}
              <span class="text-xs font-medium">
                Relay check: {get(checkedRelays).size % $userRelays.length || $userRelays.length}/{$userRelays.length}
              </span>
            {/if}
          </div>
        </div>
        <div class="w-full bg-blue-200 dark:bg-blue-800 h-1 mt-2 rounded-full">
          <div class="bg-blue-500 h-1 rounded-full" style="width:{(totalNotesChecked / recentNotes.length * 100)}%"></div>
        </div>
      </div>
    </div>
  {/if}
</main>
</div>

<style>
  main {
    max-width: 800px;
    margin: 0 auto;
  }

  :global(html), :global(body) {
    background-color: white;
  }

  :global(html.dark), :global(body.dark) {
    background-color: #111827; /* gray-900 */
  }
</style> 
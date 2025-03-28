<script lang="ts">
// Define types for global usage
declare global {
  interface Window {
    nostrZap: any;
  }
}

import { onDestroy, onMount } from 'svelte';
import { NostrFetcher } from 'nostr-fetch';
import type { Event, Filter } from 'nostr-tools';
import { Relay, SimplePool } from 'nostr-tools';
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
const DEFAULT_MAX_CONCURRENT_RELAYS = 21;
const DEFAULT_SOUND_ENABLED = false;
const DEFAULT_TIMEOUT_MS = 10000;

// Load preferences from localStorage or use defaults
let DISCOVERY_RELAYS = JSON.parse(localStorage.getItem('nadar_discovery_relays') || JSON.stringify(DEFAULT_DISCOVERY_RELAYS));
let MAX_CONCURRENT_RELAYS = parseInt(localStorage.getItem('nadar_max_concurrent_relays') || DEFAULT_MAX_CONCURRENT_RELAYS.toString());
let soundEnabled = localStorage.getItem('nadar_sound_enabled') === 'true' || DEFAULT_SOUND_ENABLED;
let timeoutMs = parseInt(localStorage.getItem('nadar_timeout_ms') || DEFAULT_TIMEOUT_MS.toString());

type TargetEvent = {
  type: 'nevent' | 'naddr';
  id?: string;  // For nevent
  pubkey?: string;
  kind?: number;
  identifier?: string;  // For naddr
  relays?: string[];
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

let searchCompleted = false;
let searchStartTime: number;
let searchDuration = 0;
let synth: Tone.Synth;
let pingSound: Tone.Player;
let clickSound: Tone.Player;
let pageTurnSound: Tone.Player;

// Save preferences to localStorage
function savePreferences() {
  localStorage.setItem('nadar_discovery_relays', JSON.stringify(DISCOVERY_RELAYS));
  localStorage.setItem('nadar_max_concurrent_relays', MAX_CONCURRENT_RELAYS.toString());
  localStorage.setItem('nadar_sound_enabled', soundEnabled.toString());
  localStorage.setItem('nadar_timeout_ms', timeoutMs.toString());
}

// Reset preferences to defaults
function resetPreferences() {
  DISCOVERY_RELAYS = [...DEFAULT_DISCOVERY_RELAYS];
  MAX_CONCURRENT_RELAYS = DEFAULT_MAX_CONCURRENT_RELAYS;
  soundEnabled = DEFAULT_SOUND_ENABLED;
  timeoutMs = DEFAULT_TIMEOUT_MS;
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
    console.error('Error discovering relays:', error);
  } finally {
    loading = false;
  }
}

async function cleanupActiveConnections() {
  // First close all subscriptions
  for (const sub of activeSubscriptions) {
    try {
      sub.close();
    } catch (error) {
      console.debug('Error closing subscription:', error);
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
      console.debug('Error closing relay:', error);
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
        console.debug('Error resuming relay:', error);
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
        console.debug('Error pausing relay:', error);
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

async function findEventOnRelays() {
  if (!targetEvent) return;
  
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

  if (sortedRelays.length === 0) {
    isSearching = false;
    searchCompleted = true;
    searchDuration = (Date.now() - searchStartTime) / 1000;
    return;
  }

  totalBatches = Math.ceil(sortedRelays.length / MAX_CONCURRENT_RELAYS);

  // Create the appropriate filter based on the type
  const filter: Filter = targetEvent.type === 'nevent' 
    ? { ids: [targetEvent.id!] }
    : {
        authors: [targetEvent.pubkey!],
        kinds: [targetEvent.kind!]
      };

  if(targetEvent?.identifier) {
    filter['#d'] = [targetEvent.identifier];
  }

  // Process relays in batches of MAX_CONCURRENT_RELAYS
  try {
    let previousBatchIndex = 0;
    
    for (let i = 0; i < sortedRelays.length && isSearching; i += MAX_CONCURRENT_RELAYS) {
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
      
      // Play page turn sound when changing batches
      if (soundEnabled && currentBatchIndex !== previousBatchIndex) {
        await playPageTurnSound();
        previousBatchIndex = currentBatchIndex;
      }
      
      currentBatch = sortedRelays.slice(i, i + MAX_CONCURRENT_RELAYS);
      
      // Track if we've found a relay in this batch
      let foundRelayInCurrentBatch = false;

      // Process each relay in the batch with a small delay between connections
      const batchPromises = currentBatch.map(async (relayUrl, index) => {
        if (!isSearching) return;

        // Add a small delay between connection attempts
        await new Promise(resolve => setTimeout(resolve, index * 50));

        let relay: Relay | undefined;
        try {
          relay = new Relay(relayUrl);
          activeRelays.push(relay);
          
          await relay.connect();
          
          // Set up a timeout for the relay query
          const timeoutPromise = new Promise<null>((resolve) => {
            setTimeout(() => resolve(null), timeoutMs);
          });
          
          // Create a promise that resolves when we find the event on this relay
          const findPromise = new Promise<boolean>((resolve) => {
            if (!relay) return resolve(false);
            
            const sub = relay.subscribe([filter], {
              onevent: (event) => {
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
                sub.close();
                resolve(false);
              }
            });
            
            activeSubscriptions.push(sub);
          });
          
          // Race between finding the event and timing out
          const found = await Promise.race([findPromise, timeoutPromise]);
          
          return { relayUrl, success: true, found: !!found };
        } catch (error) {
          console.error(`Error with relay ${relayUrl}:`, error);
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
              console.error(`Error closing relay ${relayUrl}:`, error);
            }
          }
        }
      });

      // Wait for all batch promises to complete and update checkedRelays
      const results = await Promise.all(batchPromises);
      
      // Only update checkedRelays after all promises in the batch are complete
      results.forEach(result => {
        if (result) {
          checkedRelays.update(relays => {
            relays.add(result.relayUrl);
            return relays;
          });
        }
      });

      // Add a small delay between batches
      await new Promise(resolve => setTimeout(resolve, 100));

      // Check if we've completed all relays
      if (get(checkedRelays).size === sortedRelays.length) {
        break;
      }
    }

    // Only complete if we weren't cancelled
    if (isSearching) {
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
    }
  } catch (error) {
    console.error('Error in search:', error);
    isSearching = false;
  }
}

function handleInput(event: KeyboardEvent) {
  if (event.key === 'Enter') {
    const input = event.currentTarget as HTMLInputElement;
    const value = input.value.trim();
    if (!value) return;

    inputError = '';
    
    // Check if it's a nevent or naddr
    if (!value.startsWith('nevent1') && !value.startsWith('naddr1')) {
      inputError = 'Input must be a nevent or naddr';
      input.value = '';
      return;
    }

    try {
      // Try to decode as nevent or naddr
      const decoded = nip19.decode(value);
      if (decoded.type === 'nevent') {
        const data = decoded.data as { id: string; pubkey?: string; relays?: string[] };
        targetEvent = {
          type: 'nevent',
          id: data.id,
          pubkey: data.pubkey,
          relays: data.relays?.map(normalizeRelayUrl) || []
        };
      } else if (decoded.type === 'naddr') {
        const data = decoded.data as { identifier: string; pubkey: string; kind: number; relays?: string[] };
        targetEvent = {
          type: 'naddr',
          identifier: data.identifier,
          pubkey: data.pubkey,
          kind: data.kind,
          relays: data.relays?.map(normalizeRelayUrl) || []
        };
      }
      
      if (targetEvent) {
        // Reset search state before starting new search
        searchCompleted = false;
        isSearching = false;
        foundOnRelays.set(new Set());
        checkedRelays.set(new Set());
        currentBatch = [];
        currentBatchIndex = 0;
        
        // Start the search
        findEventOnRelays();
      }
    } catch (error) {
      inputError = 'Invalid nevent or naddr format';
      console.error('Error decoding NIP-19:', error);
    }
    
    input.value = '';
  }
}

onMount(() => {
  discoverRelays();
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
</script>

<main class="container mx-auto p-4 relative">
  <div class="flex flex-col sm:flex-row items-center gap-4 mb-4">
    <div class="flex items-center gap-4">
      <img src="/nadar.png" class="h-16 w-auto" alt="NADAR 2.0" />
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
          data-npub="npub1uac67zc9er54ln0kl6e4qp2y6ta3enfcg7ywnayshvlw9r5w6ehsqq99rx"
          data-relays="wss://lunchbox.sandwich.farm,wss://nostrue.com,wss://relay.damus.io,wss://relay.nostr.band,wss://relay.primal.net,wss://wheat.happytavern.co">
          Zap Me ⚡️
        </button>
      </div>
    {/if}
  </div>

  {#if showPreferences}
    <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div class="bg-white rounded-lg p-6 max-w-2xl w-full mx-4 relative">
        <button
          class="absolute top-2 right-2 text-gray-500 hover:text-gray-700"
          on:click={() => showPreferences = false}
        >
          ✕
        </button>
        
        <h2 class="text-xl font-semibold mb-4">Preferences</h2>
        
        <div class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">
              NIP-66 Discovery Relays
            </label>
            <textarea
              class="w-full h-24 p-2 border rounded font-mono text-sm"
              bind:value={discoveryRelaysText}
              on:change={(e) => {
                const newRelays = e.currentTarget.value
                  .split('\n')
                  .map(r => r.trim())
                  .filter(r => r);
                DISCOVERY_RELAYS = newRelays;
                discoveryRelaysText = DISCOVERY_RELAYS.join('\n');
                savePreferences();
              }}
            />
            <p class="text-sm text-gray-500 mt-1">One relay URL per line</p>
          </div>

          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">
              Max Concurrent Relays
            </label>
            <input
              type="number"
              min="1"
              max="100"
              class="w-full p-2 border rounded"
              bind:value={MAX_CONCURRENT_RELAYS}
              on:change={(e) => {
                MAX_CONCURRENT_RELAYS = parseInt(e.currentTarget.value);
                savePreferences();
              }}
            />
            <p class="text-sm text-gray-500 mt-1">Number of relays to query simultaneously (1-100)</p>
          </div>

          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">
              Relay Query Timeout (ms)
            </label>
            <input
              type="number"
              min="1000"
              max="30000"
              step="1000"
              class="w-full p-2 border rounded"
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
              class="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
              bind:checked={soundEnabled}
              on:change={() => {
                if (soundEnabled) {
                  Tone.start();
                }
                savePreferences();
              }}
            />
            <label for="soundEnabled" class="ml-2 block text-sm text-gray-700">
              Enable Sound Effects
            </label>
          </div>

          <div class="flex justify-end gap-2 mt-6">
            <button
              class="px-4 py-2 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
              on:click={() => {
                resetPreferences();
                discoverRelays();
              }}
            >
              Reset to Defaults
            </button>
            <button
              class="px-4 py-2 text-sm bg-blue-500 text-white rounded hover:bg-blue-600"
              on:click={() => {
                showPreferences = false;
                discoverRelays();
              }}
            >
              Save & Rediscover
            </button>
          </div>
        </div>
      </div>
    </div>
  {/if}

    <!-- about section -->
    <div class="bg-gray-800/10 mb-4  rounded-lg p-4">
      <p class="text-gray-700">
        NADAR 2.0 is a tool for finding specific notes on nostr. 
        It discovers relays using <a href="https://github.com/nostr-protocol/nips/blob/master/66.md" class="border-b border-gray-700">NIP-66</a> 
        and searches them to locate user specified events. 
        2.0 was made by <a href="https://njump.me/npub1uac67zc9er54ln0kl6e4qp2y6ta3enfcg7ywnayshvlw9r5w6ehsqq99rx" target="_blank" class="border-b border-gray-700">sandwich</a> and is a rewrite of the <a href="https://nadar.tigerville.no/" target="_blank" class="border-b border-gray-700">original</a>.
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

  <div class="mb-4 relative">
    <input
      type="text"
      placeholder={loading ? "Please wait while relays are being loaded..." : "Enter nevent or naddr"}
      class="p-2 border rounded w-full {inputError ? 'border-red-500' : ''}"
      on:keydown={handleInput}
      disabled={isSearching || loading}
    />
    <button
      class="absolute right-2 top-1/2 -translate-y-1/2 text-gray-600 hover:text-gray-800"
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

  {#if targetEvent}
    {#if searchCompleted}
      <div class="mb-4">
        <div class="bg-green-50 border border-green-200 rounded-lg p-4 mb-4">
          <div class="flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-6 h-6 text-green-600">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <h2 class="text-xl font-semibold text-green-800">Search Complete!</h2>
          </div>
          <div class="mt-2 text-green-700">
            Search completed in {searchDuration.toFixed(1)} seconds
          </div>
        </div>

        <h2 class="text-xl font-semibold mb-2">Search Results:</h2>
        <div class="bg-gray-50 rounded-lg p-4 space-y-2">
          <div class="grid grid-cols-2 gap-4">
            <div>
              <span class="text-gray-600">Total Relays Searched:</span>
              <span class="ml-2 font-semibold">{$checkedRelays.size}</span>
            </div>
            <div>
              <span class="text-gray-600">Found On:</span>
              <span class="ml-2 font-semibold">{$foundOnRelays.size} relays</span>
            </div>
            <div>
              <span class="text-gray-600">Success Rate:</span>
              <span class="ml-2 font-semibold">
                {($foundOnRelays.size / $checkedRelays.size * 100).toFixed(1)}%
              </span>
            </div>
            <div>
              <span class="text-gray-600">Time Taken:</span>
              <span class="ml-2 font-semibold">{searchDuration.toFixed(1)}s</span>
            </div>
          </div>
        </div>
      </div>
    {/if}

    {#if isSearching}
      <div class="mb-4">
        <h2 class="text-xl font-semibold mb-2">Search Progress:</h2>
        <div class="bg-gray-50 rounded-lg p-4 space-y-2">
          <div class="grid grid-cols-2 gap-2">
            <div>
              <span class="text-gray-600">Total Relays:</span>
              <span class="ml-2">{$foundRelays.size}</span>
            </div>
            <div>
              <span class="text-gray-600">Checked Relays:</span>
              <span class="ml-2">{$checkedRelays.size}</span>
            </div>
            <div>
              <span class="text-gray-600">Found On:</span>
              <span class="ml-2">{$foundOnRelays.size}</span>
            </div>
            <div>
              <span class="text-gray-600">Remaining:</span>
              <span class="ml-2">{$foundRelays.size - $checkedRelays.size}</span>
            </div>
          </div>
        </div>
      </div>
    {/if}

    <div class="mb-4">
      <h2 class="text-xl font-semibold mb-2">Search Details:</h2>
      <div class="bg-gray-50 rounded-lg p-4 space-y-2">
          <div>
            <span class="text-gray-600">Type:</span>
            <span class="font-mono ml-2">{targetEvent.type}</span>
          </div>
          <div class="flex items-center">
            <span class="text-gray-600">ID:</span>
            <span class="font-mono ml-2 text-sm break-all flex-1">{targetEvent.id}</span>
            {#if targetEvent.id}
            <button
              class="ml-2 p-1.5 text-gray-600 hover:text-gray-800 rounded-md hover:bg-gray-100"
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
              <span class="text-gray-600">Pubkey:</span>
              <span class="font-mono ml-2 text-sm break-all">{targetEvent.pubkey}</span>
            </div>
          {/if}
          <div>
            <span class="text-gray-600">Relays from NIP-19:</span>
            <span class="ml-2">{targetEvent.relays?.length || 0}</span>
          </div>
      </div>
    </div>

    <div class="flex gap-2 my-4">
      <button
        class="px-4 py-2 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50"
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
    
    <div class="mb-4">
      <h2 class="text-xl font-semibold mb-2">Searching for event:</h2>
      <p class="font-mono text-sm">{targetEvent.id}</p>
      
      {#if currentBatch.length > 0}
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
              <div class="p-1.5 rounded text-xs font-mono truncate hover:bg-gray-100 flex items-center gap-1
                {$foundOnRelays.has(relay) 
                  ? 'bg-green-50 text-green-700' 
                  : $checkedRelays.has(relay) 
                    ? 'bg-red-50 text-red-700' 
                    : 'bg-gray-50 text-gray-700'}">
                <span class="w-1.5 h-1.5 rounded-full 
                  {$foundOnRelays.has(relay) 
                    ? 'bg-green-500' 
                    : $checkedRelays.has(relay) 
                      ? 'bg-red-500' 
                      : 'bg-gray-400'}"></span>
                {relay}
              </div>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  {/if}

  {#if $foundOnRelays.size > 0}
    <div class="mb-4">
      <h2 class="text-xl font-semibold mb-2">Found on {$foundOnRelays.size} relays:</h2>
      <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-1">
        {#each [...$foundOnRelays].sort() as relay}
          <div class="p-1.5 bg-green-50 text-green-700 rounded shadow text-xs font-mono truncate hover:bg-green-100 flex items-center gap-1">
            <span class="w-1.5 h-1.5 rounded-full bg-green-500"></span>
            {relay}
          </div>
        {/each}
      </div>

      <div class="mt-4">
        <h3 class="text-sm font-semibold text-gray-600 mb-2">Copy relays as...</h3>
        <div class="flex gap-2">
          <button
            class="px-3 py-1.5 bg-gray-100 text-gray-700 rounded hover:bg-gray-200 text-sm"
            on:click={() => {
              const relays = [...$foundOnRelays].sort();
              navigator.clipboard.writeText(relays.join('\n'));
            }}
          >
            Newline list
          </button>
          <button
            class="px-3 py-1.5 bg-gray-100 text-gray-700 rounded hover:bg-gray-200 text-sm"
            on:click={() => {
              const relays = [...$foundOnRelays].sort();
              navigator.clipboard.writeText(relays.join(', '));
            }}
          >
            Comma list
          </button>
          <button
            class="px-3 py-1.5 bg-gray-100 text-gray-700 rounded hover:bg-gray-200 text-sm"
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

  {#if loading}
    <div class="animate-pulse">
      <div class="h-4 bg-gray-200 rounded w-3/4 mb-2"></div>
      <div class="h-4 bg-gray-200 rounded w-1/2"></div>
      <div class="h-4 bg-gray-200 rounded w-5/6"></div>
    </div>
  {/if}
</main>

<style>
  main {
    max-width: 800px;
    margin: 0 auto;
  }
</style> 
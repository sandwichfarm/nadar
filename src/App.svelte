<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { NostrFetcher } from 'nostr-fetch';
  import type { Event, Filter } from 'nostr-tools';
  import { Relay, SimplePool } from 'nostr-tools';
  import { nip19 } from 'nostr-tools';
  import { get, writable, type Writable } from 'svelte/store';
  import type { SubCloser } from 'nostr-tools/abstract-pool';

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

  // Load preferences from localStorage or use defaults
  let DISCOVERY_RELAYS = JSON.parse(localStorage.getItem('nadar_discovery_relays') || JSON.stringify(DEFAULT_DISCOVERY_RELAYS));
  let MAX_CONCURRENT_RELAYS = parseInt(localStorage.getItem('nadar_max_concurrent_relays') || DEFAULT_MAX_CONCURRENT_RELAYS.toString());

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

  // Save preferences to localStorage
  function savePreferences() {
    localStorage.setItem('nadar_discovery_relays', JSON.stringify(DISCOVERY_RELAYS));
    localStorage.setItem('nadar_max_concurrent_relays', MAX_CONCURRENT_RELAYS.toString());
  }

  // Reset preferences to defaults
  function resetPreferences() {
    DISCOVERY_RELAYS = [...DEFAULT_DISCOVERY_RELAYS];
    MAX_CONCURRENT_RELAYS = DEFAULT_MAX_CONCURRENT_RELAYS;
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
        if (relay.status === 1) {
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
          if (relay.status === 3) { // CLOSED
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
          if (relay.status === 1) { // CONNECTED
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
    
    // Sort relays to prioritize those from the NIP-19 encoding
    const relayArray = [...get(foundRelays)];
    const sortedRelays = relayArray.sort((a, b) => {
      // Normalize both the relay URLs from NIP-19 and the found relays for comparison
      const normalizedA = normalizeRelayUrl(a);
      const normalizedB = normalizeRelayUrl(b);
      const normalizedNip19Relays = targetEvent?.relays?.map(normalizeRelayUrl) || [];
      
      const aInNip19 = normalizedNip19Relays.includes(normalizedA);
      const bInNip19 = normalizedNip19Relays.includes(normalizedB);
      
      if (aInNip19 && !bInNip19) return -1;
      if (!aInNip19 && bInNip19) return 1;
      return 0;
    });

    foundOnRelays.set(new Set()); 
    checkedRelays.set(new Set());
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
    for (let i = 0; i < sortedRelays.length; i += MAX_CONCURRENT_RELAYS) {
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

      currentBatchIndex = Math.floor(i / MAX_CONCURRENT_RELAYS) + 1;
      currentBatch = sortedRelays.slice(i, i + MAX_CONCURRENT_RELAYS);
      
      // Create a promise that resolves when all relays in the batch have sent EOSE
      const batchPromise = new Promise<void>((resolve) => {
        let eoseCount = 0;
        let connectionPromises: Promise<void>[] = [];

        // Create and connect to each relay in the batch
        for (const relayUrl of currentBatch) {
          const connectionPromise = (async () => {
            try {
              const relay = await Relay.connect(relayUrl);
              let timeout: ReturnType<typeof setTimeout>;

              activeRelays.push(relay);

              await new Promise<void>((resolveRelay) => {
                const finish = () => {
                  clearTimeout(timeout);
                  if (sub) {
                    try {
                      const index = activeSubscriptions.indexOf(sub);
                      if (index > -1) {
                        activeSubscriptions.splice(index, 1);
                      }
                      sub.close();
                    } catch (error) {
                      console.debug('Error closing subscription in finish:', error);
                    }
                  }
                  
                  try {
                    relay.close();
                    const relayIndex = activeRelays.indexOf(relay);
                    if (relayIndex > -1) {
                      activeRelays.splice(relayIndex, 1);
                    }
                  } catch (error) {
                    console.debug('Error closing relay in finish:', error);
                  }

                  eoseCount++;
                  if (eoseCount === currentBatch.length) {
                    resolve();
                  }
                  resolveRelay();
                };
                
                const sub = relay.subscribe([filter], {
                  onevent() {
                    if (!isSearching) return;
                    foundOnRelays.update(relays => {
                      relays.add(relayUrl);
                      return relays;
                    });
                  },
                  oneose() {
                    finish();
                  }
                });

                activeSubscriptions.push(sub);

                // Set a timeout to close the subscription and relay after 8 seconds
                timeout = setTimeout(finish, 8000);
              });
            } catch (error) {
              console.debug('Error connecting to relay:', error);
              eoseCount++;
              if (eoseCount === currentBatch.length) {
                resolve();
              }
            }
          })();
          
          connectionPromises.push(connectionPromise);
        }

        // Wait for all connections to be established or failed
        Promise.all(connectionPromises).catch(console.debug);
      });

      // Wait for all relays in the batch to complete
      await batchPromise;
      
      // Mark any remaining unchecked relays in this batch as checked
      currentBatch.forEach(relay => {
        if (!$foundOnRelays.has(relay) && !$checkedRelays.has(relay)) {
          checkedRelays.update(relays => {
            relays.add(relay);
            return relays;
          });
        }
      });

      // Small delay between batches to let resources be cleaned up
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    currentBatch = [];
    currentBatchIndex = 0;
    isSearching = false;
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
    import('https://cdn.jsdelivr.net/npm/nostr-zap@latest').then(() => {
      zapLoaded.set(true);
    });
  });

  onDestroy(() => {
    zapLoaded.set(false);
    (window as any).nostrZap = undefined;
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
    <div class="mb-4">
      <h2 class="text-xl font-semibold mb-2">Search Details:</h2>
      <div class="bg-gray-50 rounded-lg p-4 space-y-2">
        <div class="grid grid-cols-2 gap-2">
          <div>
            <span class="text-gray-600">Type:</span>
            <span class="font-mono ml-2">{targetEvent.type}</span>
          </div>
          <div>
            <span class="text-gray-600">ID:</span>
            <span class="font-mono ml-2 text-sm break-all">{targetEvent.id}</span>
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
    </div>

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
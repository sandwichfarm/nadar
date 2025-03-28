<script lang="ts">
  import { onMount } from 'svelte';
  import { NostrFetcher } from 'nostr-fetch';
  import type { Event, Filter } from 'nostr-tools';
  import { Relay, SimplePool } from 'nostr-tools';
  import { nip19 } from 'nostr-tools';
  import { get, writable, type Writable } from 'svelte/store';
    import type { SubCloser } from 'nostr-tools/abstract-pool';

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

  const DISCOVERY_RELAYS = [
    'wss://relay.nostr.watch',
    'wss://relaypag.es'
  ];

  const MAX_CONCURRENT_RELAYS = 21;

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
      sub.close();
    }
    activeSubscriptions = [];

    // Then close all relay connections
    for (const relay of activeRelays) {
      relay.close();
    }
    activeRelays = [];

    // Wait a tick to ensure all cleanup is processed
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  function togglePause() {
    if (isPaused) {
      // Resume all active relays
      activeRelays.forEach(relay => relay.connect());
    } else {
      // Pause all active relays
      activeRelays.forEach(relay => relay.close());
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

        // Create and connect to each relay in the batch
        currentBatch.forEach(async (relayUrl: string) => {
          try {
            const relay = await Relay.connect(relayUrl);
            let timeout: ReturnType<typeof setTimeout>;

            activeRelays.push(relay);

            const finish = () => {
              if (sub) {
                const index = activeSubscriptions.indexOf(sub);
                if (index > -1) {
                  activeSubscriptions.splice(index, 1);
                }
                sub.close();
              }
              relay.close();
              const relayIndex = activeRelays.indexOf(relay);
              if (relayIndex > -1) {
                activeRelays.splice(relayIndex, 1);
              }
              eoseCount++;
              
              if (eoseCount === currentBatch.length) {
                resolve();
              }
            };
            
            const sub = relay.subscribe([filter], {
              onevent(event: Event) {
                if (!isSearching) return; // Don't process events if we're not searching
                foundOnRelays.update(relays => {
                  relays.add(relayUrl);
                  return relays;
                });
              },
              oneose() {
                clearTimeout(timeout);
                finish();
              }
            });
            activeSubscriptions.push(sub);

            // Set a timeout to close the subscription and relay after 8 seconds
            timeout = setTimeout(finish, 8000);
          } catch (error) {
            eoseCount++;
            if (eoseCount === currentBatch.length) {
              resolve();
            }
          }
        });
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
  });
</script>

<main class="container mx-auto p-4">
  <h1 class="text-6xl font-bold mb-4">NADAR <small class="opacity-50">2.0</small></h1>
  
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

  <div class="mb-4">
    <input
      type="text"
      placeholder={loading ? "Please wait while relays are being loaded..." : "Enter nevent or naddr"}
      class="p-2 border rounded w-full {inputError ? 'border-red-500' : ''}"
      on:keydown={handleInput}
      disabled={isSearching || loading}
    />
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
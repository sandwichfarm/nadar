<script lang="ts">
  import { onMount } from 'svelte';
  import { NostrFetcher } from 'nostr-fetch';
  import type { Event } from 'nostr-tools';
  import { SimplePool } from 'nostr-tools';
  import { nip19 } from 'nostr-tools';
    import { writable, type Writable } from 'svelte/store';

  let loading = false;
  let foundRelays: Writable<Set<string>> = writable(new Set<string>());
  let totalEvents = 0;
  let startTime: number;
  let targetEvent: { id: string; pubkey: string } | undefined;
  let foundOnRelays = new Set<string>();
  let checkedRelays = new Set<string>();
  let inputValue = '';
  let currentBatch: string[] = [];
  let currentBatchIndex = 0;
  let totalBatches = 0;

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
      // Use nostr-fetch to get events from the last 24 hours
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
          relays.add(url)
          return relays;
        })
      }
    } catch (error) {
      console.error('Error discovering relays:', error);
    } finally {
      loading = false;
    }
  }

  async function findEventOnRelays() {
    if (!targetEvent) return;
    
    const relays = [...$foundRelays];
    const pool = new SimplePool();
    foundOnRelays.clear();
    checkedRelays.clear();
    totalBatches = Math.ceil(relays.length / MAX_CONCURRENT_RELAYS);

    // Process relays in batches of MAX_CONCURRENT_RELAYS
    for (let i = 0; i < relays.length; i += MAX_CONCURRENT_RELAYS) {
      currentBatchIndex = Math.floor(i / MAX_CONCURRENT_RELAYS) + 1;
      currentBatch = relays.slice(i, i + MAX_CONCURRENT_RELAYS);
      const sub = pool.subscribeMany(
        currentBatch,
        [{ ids: [targetEvent.id] }],
        {
          onevent(event: Event) {
            if (event.id === targetEvent?.id) {
              // Get the relay URL from the subscription
              const relayUrl = currentBatch.find(relay => {
                // @ts-ignore - SimplePool has this method but TypeScript doesn't know about it
                const relayConnection = pool.getRelay(relay);
                return relayConnection && relayConnection.status === 1;
              }) || 'unknown';
              foundOnRelays.add(relayUrl);
            }
          },
          oneose() {
            // When we receive EOSE, mark all relays in the current batch as checked
            // unless they've already been marked as found
            console.log('eose');
            currentBatch.forEach(relay => {
              if (!foundOnRelays.has(relay)) {
                checkedRelays.add(relay);
              }
            });
          }
        }
      );

      // Wait for 8 seconds before moving to next batch (defensive timeout)
      await new Promise(resolve => setTimeout(resolve, 8000));
      sub.close();
      
      // Mark any remaining unchecked relays in this batch as checked
      currentBatch.forEach(relay => {
        if (!foundOnRelays.has(relay) && !checkedRelays.has(relay)) {
          checkedRelays.add(relay);
        }
      });
    }

    pool.close(relays);
    currentBatch = [];
    currentBatchIndex = 0;
  }

  function handleInput(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      const input = event.currentTarget as HTMLInputElement;
      const value = input.value.trim();
      if (!value) return;

      try {
        // Try to decode as nevent or naddr
        const decoded = nip19.decode(value);
        if (decoded.type === 'nevent') {
          const data = decoded.data as { id: string; pubkey?: string };
          targetEvent = {
            id: data.id,
            pubkey: data.pubkey || ''
          };
        } else if (decoded.type === 'naddr') {
          const data = decoded.data as { identifier: string; pubkey?: string };
          targetEvent = {
            id: data.identifier,
            pubkey: data.pubkey || ''
          };
        }

        console.log(targetEvent);
        
        if (targetEvent) {
          findEventOnRelays();
        }
      } catch (error) {
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
  <h1 class="text-2xl font-bold mb-4">Nostr Relay Discovery</h1>
  
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
      placeholder="Enter nevent or naddr"
      class="p-2 border rounded w-full"
      on:keydown={handleInput}
    />
  </div>

  {#if targetEvent}
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
                {foundOnRelays.has(relay) 
                  ? 'bg-green-50 text-green-700' 
                  : checkedRelays.has(relay) 
                    ? 'bg-red-50 text-red-700' 
                    : 'bg-gray-50 text-gray-700'}">
                <span class="w-1.5 h-1.5 rounded-full 
                  {foundOnRelays.has(relay) 
                    ? 'bg-green-500' 
                    : checkedRelays.has(relay) 
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

  {#if foundOnRelays.size > 0}
    <div class="mb-4">
      <h2 class="text-xl font-semibold mb-2">Found on {foundOnRelays.size} relays:</h2>
      <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-1">
        {#each [...foundOnRelays].sort() as relay}
          <div class="p-1.5 bg-green-50 text-green-700 rounded shadow text-xs font-mono truncate hover:bg-green-100 flex items-center gap-1">
            <span class="w-1.5 h-1.5 rounded-full bg-green-500"></span>
            {relay}
          </div>
        {/each}
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
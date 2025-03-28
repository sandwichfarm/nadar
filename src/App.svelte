<script lang="ts">
  import { onMount } from 'svelte';
  import { SimplePool, relayInit } from 'nostr-tools';
  import type { Filter, Event, Sub } from 'nostr-tools';
  import { bech32 } from 'bech32';

  interface RelayResult {
    url: string;
    latency?: number;
  }

  interface Results {
    Found: RelayResult[];
    Missing: RelayResult[];
    Unresponsive: RelayResult[];
    Dead: RelayResult[];
  }

  let eventInput = '';
  let statusText = '';
  let results: Results = {
    Found: [],
    Missing: [],
    Unresponsive: [],
    Dead: []
  };
  let filterText = '';
  let showResults = false;
  let discoveredRelays: string[] = [];

  // Known monitor pubkeys that publish NIP-66 events
  const MONITOR_PUBKEYS = [
    // Add known monitor pubkeys here
    // These should be pubkeys that regularly publish 30166 events
  ];

  // Discovery relays to fetch NIP-66 events from
  const DISCOVERY_RELAYS = [
    'wss://relaypag.es',
    'wss://relay.nostr.watch'
  ];

  function bech32toHex(str: string): string {
    const words = bech32.decode(str).words;
    const bytes = bech32.fromWords(words);
    return bytes.map((byte) => ('0' + (byte & 0xFF).toString(16)).slice(-2)).join("");
  }

  function shuffleArray<T>(array: T[]): void {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const temp = array[i];
      array[i] = array[j];
      array[j] = temp;
    }
  }

  async function discoverRelays(): Promise<string[]> {
    const pool = new SimplePool();
    const relays = new Set<string>();
    const now = Math.floor(Date.now() / 1000);
    const oneDayAgo = now - (24 * 60 * 60);

    // Create filter for 30166 events from the last 24 hours
    const filter: Filter = {
      kinds: [30166],
      since: oneDayAgo
    };

    try {
      // Subscribe to events from discovery relays
      const sub = pool.sub(DISCOVERY_RELAYS, [filter]);
      
      return new Promise((resolve) => {
        sub.on('event', (event: Event) => {
          // Extract relay URL from the 'd' tag
          const relayTag = event.tags.find((tag: string[]) => tag[0] === 'd');
          if (relayTag && relayTag[1]) {
            relays.add(relayTag[1]);
          }
        });

        sub.on('eose', () => {
          sub.unsub();
          pool.close(DISCOVERY_RELAYS);
          resolve(Array.from(relays));
        });
      });
    } catch (error) {
      console.error('Error discovering relays:', error);
      return [];
    }
  }

  async function checkRelay(url: string, eventID: string): Promise<[string, { latency?: number }]> {
    let relay = relayInit(url);
    let state = "connecting";
    let timeoutID: number | null = null;

    function finish() {
      state = "finished";
      if (timeoutID) {
        clearTimeout(timeoutID);
        timeoutID = null;
      }
      relay.close();
      relay = null;
    }

    const timeoutPromise = new Promise<[string, {}]>((resolve) => {
      timeoutID = window.setTimeout(() => {
        console.log(`Dropped ${url} (${state === "connecting" ? "dead" : "slow"})`);
        finish();
        if (state === "connecting") {
          resolve(["Dead", {}]);
        } else {
          resolve(["Unresponsive", {}]);
        }
      }, 15000);
    });

    relay.on("notice", (notice: string) => console.log(url, "NOTICE:", notice));
    const checkPromise = relay.connect()
      .then(() => new Promise<[string, { latency?: number }]>((resolve) => {
        state = "connected";
        const queryStart = performance.now();
        const sub = relay.sub([{ ids: [eventID] }]);
        sub.on("event", (event: Event) => {
          state = "found";
        });
        sub.on("eose", () => {
          const latency = Math.round(performance.now() - queryStart);
          if (state === "found") {
            finish();
            resolve(["Found", { latency }]);
          } else {
            finish();
            resolve(["Missing", { latency }]);
          }
        });
      }))
      .catch((error: Error) => {
        if (state !== "finished") {
          console.log(`Can't connect to ${url}:`, error);
          finish();
          return ["Dead", {}];
        }
      });

    return Promise.race([checkPromise, timeoutPromise]);
  }

  async function handleCheck() {
    if (!eventInput) {
      statusText = "Please enter an event ID";
      return;
    }

    statusText = "Discovering relays...";
    showResults = false;
    results = {
      Found: [],
      Missing: [],
      Unresponsive: [],
      Dead: []
    };

    // Discover relays using NIP-66
    discoveredRelays = await discoverRelays();
    
    if (discoveredRelays.length === 0) {
      statusText = "No relays discovered. Please try again later.";
      return;
    }

    statusText = "Checking relays...";
    let eventID = eventInput;
    if (eventInput.startsWith('note1')) {
      eventID = bech32toHex(eventInput);
    }

    const relayUrls = [...discoveredRelays];
    shuffleArray(relayUrls);

    const checks = relayUrls.map(url => checkRelay(url, eventID));
    let checkResults = await Promise.all(checks);

    checkResults.forEach(([status, data], index) => {
      if (status === "Found") {
        results.Found.push({ url: relayUrls[index], ...data });
      } else if (status === "Missing") {
        results.Missing.push({ url: relayUrls[index], ...data });
      } else if (status === "Unresponsive") {
        results.Unresponsive.push({ url: relayUrls[index], ...data });
      } else if (status === "Dead") {
        results.Dead.push({ url: relayUrls[index], ...data });
      }
    });

    showResults = true;
    statusText = "Check complete!";
  }

  $: filteredResults = {
    Found: results.Found.filter(r => r.url.toLowerCase().includes(filterText.toLowerCase())),
    Missing: results.Missing.filter(r => r.url.toLowerCase().includes(filterText.toLowerCase())),
    Unresponsive: results.Unresponsive.filter(r => r.url.toLowerCase().includes(filterText.toLowerCase())),
    Dead: results.Dead.filter(r => r.url.toLowerCase().includes(filterText.toLowerCase()))
  };
</script>

<main class="container mx-auto px-4 py-8 max-w-4xl">
  <h1 class="text-4xl font-bold mb-4 flex items-center gap-2">
    NADAR
    <img src="/nadar.png" alt="NADAR Logo" class="h-8 w-8">
  </h1>

  <p class="mb-6">
    NADAR can be used to check where your post is visible on Nostr.
    It checks every relay listed as online on <a href="https://nostr.watch/" target="_blank" class="text-blue-600 hover:underline">nostr.watch</a>.
    Relays are considered unresponsive or dead if they take longer than 15 seconds to respond.
    Queries are run from <em>your</em> browser, device and network.
  </p>

  <form on:submit|preventDefault={handleCheck} class="mb-6">
    <div class="mb-4">
      <input
        type="text"
        bind:value={eventInput}
        placeholder="Event ID (note ID or hex value)"
        class="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
      />
    </div>
    <button
      type="submit"
      class="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
    >
      Check
    </button>
  </form>

  <p class="mb-4 text-gray-600">{statusText}</p>

  {#if showResults}
    <div class="space-y-6">
      <input
        type="text"
        bind:value={filterText}
        placeholder="Filter relays..."
        class="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
      />

      {#each Object.entries(filteredResults) as [category, relays]}
        {#if relays.length > 0}
          <div class="bg-white rounded-lg shadow overflow-hidden">
            <h2 class="text-xl font-semibold p-4 bg-gray-50 border-b">{category}</h2>
            <div class="divide-y">
              {#each relays as relay}
                <div class="p-4 flex justify-between items-center">
                  <span class="font-mono">{relay.url}</span>
                  {#if relay.latency}
                    <span class="text-gray-600">{relay.latency}ms</span>
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        {/if}
      {/each}
    </div>
  {/if}

  <div class="mt-8 bg-white rounded-lg shadow overflow-hidden">
    <div class="p-4">
      <h2 class="text-xl font-semibold mb-2">About the author</h2>
      <div class="flex gap-4">
        <img src="/thorwegian.png" alt="Thorwegian" class="w-24 h-24 rounded-lg">
        <div>
          <p class="text-gray-600">
            Born in 1983, Thorwegian has been writing code since the early 1990s.
            He can be found on <a href="https://berserker.town/@thor" target="_blank" class="text-blue-600 hover:underline">Mastodon</a>.
          </p>
        </div>
      </div>
    </div>
  </div>
</main>

<style>
  :global(body) {
    @apply bg-gray-50;
  }
</style> 
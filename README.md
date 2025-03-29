# NADAR 2.0

NADAR is a tool for finding nevents and naddrs across the Nostr network. It discovers relays using NIP-66 and searches them to locate specific events.

NADAR 2.0 a complete rewrite by of the original <a href="https://nadar.tigerville.no/" target="_blank" class="border-b border-gray-700">NADAR</a> by <a href="https://njump.me/npub16ema6x3r8x8pe32lwnsll0krqmy79h5vvap8sdd7q5yhy4q2dv6slt6le9" target="_blank" class="border-b border-gray-700">Thorwegian</a>.

https://github.com/user-attachments/assets/190284a9-8b14-4c24-95f8-c9e4c4c951f7

## Features

- Find nevents and naddrs across the Nostr network
- Real-time search status with color-coded results
- Automatic relay discovery via NIP-66
- Modern UI with Svelte and Tailwind CSS

## Development

This project uses:
- Svelte for the UI framework
- Tailwind CSS for styling
- Vite for build tooling
- TypeScript for type safety
- Vitest for testing

### Prerequisites

- Node.js 16 or later
- pnpm package manager

### Setup

1. Install dependencies:
```bash
pnpm install
```

2. Start the development server:
```bash
pnpm dev
```

3. Build for production:
```bash
pnpm build
```

4. Run tests:
```bash
pnpm test
```

## License

This project is open source and available under the MIT License. 

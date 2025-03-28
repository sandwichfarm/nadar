import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import App from './App.svelte'

describe('App', () => {
  it('renders the title', () => {
    render(App)
    expect(screen.getByText('NADAR')).toBeTruthy()
  })

  it('renders the description', () => {
    render(App)
    expect(screen.getByText(/NADAR can be used to check where your post is visible on Nostr/)).toBeTruthy()
  })
})
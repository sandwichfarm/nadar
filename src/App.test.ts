import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import App from './App.svelte'

describe('App', () => {
  it('renders the main heading', () => {
    render(App)
    expect(screen.getByText('NADAR')).toBeInTheDocument()
  })

  it('renders the description text', () => {
    render(App)
    expect(screen.getByText(/NADAR can be used to check where your post is visible on Nostr/)).toBeInTheDocument()
  })
}) 
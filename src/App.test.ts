import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import App from './App.svelte'

describe('App', () => {
  it('renders the title', () => {
    render(App)
    expect(screen.getByText('NADAR')).toBeTruthy()
  })

  it('renders mode switcher tabs', () => {
    render(App)
    expect(screen.getByText('Find Note by ID')).toBeTruthy()
    expect(screen.getByText('Check Your Notes')).toBeTruthy()
  })
  
  it('renders the description', () => {
    render(App)
    expect(screen.getByText(/NADAR 2.0 is a tool for finding specific notes on nostr/)).toBeTruthy()
  })
})
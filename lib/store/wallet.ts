'use client';

// Wallet UI state — mode, network, currently-open modal. Wallet
// secrets live server-side (D-012); this store just drives view.

import { create } from 'zustand';

export type WalletMode = 'fiat' | 'blockchain';
export type RvnNetwork = 'mainnet' | 'testnet';
export type WalletModalKind =
  | null
  | 'rvn-create'
  | 'rvn-import'
  | 'rvn-unlock'
  | 'rvn-mnemonic'
  | 'rvn-settings'
  | 'ipfs-config';

interface WalletState {
  mode: WalletMode;
  network: RvnNetwork;
  modal: WalletModalKind;
  setMode(m: WalletMode): void;
  setNetwork(n: RvnNetwork): void;
  openModal(m: WalletModalKind): void;
  closeModal(): void;
}

export const useWallet = create<WalletState>(set => ({
  mode: 'fiat',
  network: 'mainnet',
  modal: null,
  setMode(mode) {
    set({ mode });
  },
  setNetwork(network) {
    set({ network });
  },
  openModal(modal) {
    set({ modal });
  },
  closeModal() {
    set({ modal: null });
  },
}));

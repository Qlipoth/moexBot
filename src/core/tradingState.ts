/**
 * Глобальное состояние торговли: вкл/выкл, режим «только закрытие».
 */

class TradingState {
  private enabled = false;
  private closeOnlyMode = false;

  enable(): void {
    this.enabled = true;
    this.closeOnlyMode = false;
    console.log('[TRADING] ENABLED');
  }

  disable(): void {
    this.enabled = false;
    this.closeOnlyMode = false;
    console.log('[TRADING] DISABLED');
  }

  setCloseOnlyMode(value: boolean): void {
    this.closeOnlyMode = value;
    console.log(`[TRADING] Close-only mode: ${value ? 'ON' : 'OFF'}`);
  }

  isCloseOnlyMode(): boolean {
    return this.closeOnlyMode;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  allowNewEntries(): boolean {
    return this.enabled && !this.closeOnlyMode;
  }
}

export const tradingState = new TradingState();

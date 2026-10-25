// Decides when the Bluetooth stack looks wedged. Seen on the Pi after a few
// failed connections whose disconnect timed out: stopping the scan then times
// out every cycle and the sensors fade out until nothing is heard at all, while
// the process itself stays "online". Restarting the collector clears it.

export interface CycleHealth {
  /** Adopted sensors that should have been heard. */
  adopted: number;
  /** Adopted sensors heard during the scan. */
  heardAdopted: number;
  /** Stopping the scan timed out. */
  stopTimedOut: boolean;
}

/** Bad cycles in a row before the collector restarts (2 × 20 min by default). */
export const WEDGED_AFTER_CYCLES = 2;

export class BleHealth {
  private silent = 0;
  private stuck = 0;

  /** Records one cycle. Returns why BLE looks wedged, or null if it looks fine. */
  record(c: CycleHealth): string | null {
    this.silent = c.adopted > 0 && c.heardAdopted === 0 ? this.silent + 1 : 0;
    this.stuck = c.stopTimedOut ? this.stuck + 1 : 0;
    if (this.silent >= WEDGED_AFTER_CYCLES) return `no sensor heard in ${this.silent} scans in a row`;
    if (this.stuck >= WEDGED_AFTER_CYCLES) return `stopping the scan timed out ${this.stuck} times in a row`;
    return null;
  }
}

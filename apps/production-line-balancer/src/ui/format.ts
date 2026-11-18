import { Rational } from '../core/rational';

export function formatRate(value: string): string {
  return Rational.parse(value).toDecimal(2);
}

export function formatExactMachine(value: string): string {
  return Rational.parse(value).toDecimal(2, 'ceiling', false);
}

export function formatPower(valueKW: string): string {
  const value = Rational.parse(valueKW);
  if (value.compare(Rational.of(1_000_000n)) >= 0) {
    return `${value.divide(Rational.of(1_000_000n)).toDecimal(3)} GW`;
  }
  if (value.compare(Rational.of(1000n)) >= 0) {
    return `${value.divide(Rational.of(1000n)).toDecimal(3)} MW`;
  }
  return `${value.toDecimal(1)} kW`;
}

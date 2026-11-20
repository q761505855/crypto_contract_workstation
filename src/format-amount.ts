export function displayAmount(value: string | number, digits = 2) {
  return Number(value).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

export function displayRate(value: string | number) {
  return `${(Number(value) * 100).toFixed(2)}%`
}

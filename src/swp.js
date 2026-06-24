export function buildSwpProjection({ principal, monthlyWithdrawal, annualReturn, years }) {
  const opening = Number(principal) || 0;
  const withdrawal = Number(monthlyWithdrawal) || 0;
  const annual = Number(annualReturn) || 0;
  const duration = Number(years) || 0;
  if (opening < 0 || withdrawal < 0) throw new Error("Investment and withdrawal amounts cannot be negative.");
  if (annual < -100 || annual > 100) throw new Error("Annual return must be between -100% and 100%.");
  if (duration <= 0 || duration > 40) throw new Error("SWP tenure must be between 1 and 40 years.");
  const rate = annual / 100 / 12;
  const totalMonths = Math.round(duration * 12);
  let balance = opening;
  let withdrawn = 0;
  const rows = [];
  for (let month = 1; month <= totalMonths; month += 1) {
    balance *= 1 + rate;
    const actualWithdrawal = Math.min(balance, withdrawal);
    balance -= actualWithdrawal;
    withdrawn += actualWithdrawal;
    if (month % 12 === 0 || month === totalMonths) {
      rows.push({
        year: Math.ceil(month / 12),
        endingCorpus: Math.max(0, balance),
        totalWithdrawn: withdrawn,
      });
    }
    if (balance <= 0) {
      for (let remaining = month + 1; remaining <= totalMonths; remaining += 1) {
        if (remaining % 12 === 0 || remaining === totalMonths) {
          rows.push({ year: Math.ceil(remaining / 12), endingCorpus: 0, totalWithdrawn: withdrawn });
        }
      }
      break;
    }
  }
  return { assumptions: { principal: opening, monthlyWithdrawal: withdrawal, annualReturn: annual, years: duration }, rows };
}

function scoreLead(data = {}) {
  let score = 0;
  if (data.businessType) score += 15;
  if (Array.isArray(data.linesOfBusiness) ? data.linesOfBusiness.length : data.linesOfBusiness) score += 20;
  if (data.employeeCount && Number(data.employeeCount) >= 3) score += 15;
  if (data.currentlyInsured === false) score += 10;   // no coverage right now = urgent
  if (data.hasContractRequirement) score += 20;       // a GC is requiring it = a real deal
  if (data.attendeeEmail || data.email) score += 20;  // gave real contact info = serious
  return Math.min(score, 100);
}

module.exports = { scoreLead };
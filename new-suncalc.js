



let lw = -lng * deg2rad;
let phi = lat * deg2rad;
let J = dateToJulianDate(date);

let n = getJulianCycle(J, lw);
let Js = getApproxSolarTransit(0, lw, n);
let M = getSolarMeanAnomaly(Js);
let C = getEquationOfCenter(M);
let Lsun = getEclipticLongitude(M, C);
let d = getSunDeclination(Lsun);
let Jtransit = getSolarTransit(Js, M, Lsun);
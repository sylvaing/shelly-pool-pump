print("TIME START***********");

let result = {
  unixtime: null,
  };
result = Shelly.getComponentStatus("sys");

//J is days of the years
let J = Math.ceil( ((result.unixtime/31556926) - Math.floor( result.unixtime / 31556926 )) * 365.24);

J= 39
print("Days of the year : ", J);

/// equation du temps / version simple
// E = 7.53 cos(B) + 1.5sin(B) - 9.87sin(2B)
// avec B= (2pi(J-81))/365
// avec J le numero du jour ( quantième)

let E;
let B;
let pi = 3.14159265359;
// B = ((2 * pi) * ( J - 81 ))  / 364;
// E = (7.53 * Math.cos(B)) + (1.5 * Math.sin(B)) - (9.87 * Math.sin(2*B));

// print("time equation : ", E);

// ///*********************************** */
// //equation du temps complète
// //anomalie moyenne simple
// let M;
// M = 357.5291 + 0.98560028 * J;

// //anomalie moyenn avec jour Julien
// let J1970 = 2440588;
// let J2000 = 2451545;
// let Jj = result.unixtime / (3600 * 24) + J1970;

// M = 357.5291 + 0.98560028 * (Jj - J2000);

// //Contribution de l'ellipticité de la trajectoire
// let C = 1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3*M);

// //Calcul de la longitude écliptique
// let Ls = 280.47 + 0.98560028 * J + C ;

// //Contribution de l'obliquité de la Terre

// let R = -2.468 * Math.sin( 2 * Ls) + 0.053 * Math.sin(4 *Ls) - 0.0014 * Math.sin(6*Ls);

// E = (C + R) *4
// print("time equation COMPLIQUE: ", E);

//////////
let J1970 = 2440588;
let J2000 = 2451545;
let deg2rad = pi / 180;
let J0 = 0.0009;
let J1 = 0.0053;
let = -0.0069;


function getApproxSolarTransit( Ht, lw, n ) { 
  return J2000 + J0 + (Ht + lw)/(2 * pi) + n; 
}

function getSolarMeanAnomaly( Js ) { 
  return M0 + M1 * (Js - J2000); 
}

function getEclipticLongitude( M, C ) { 
  return M + P + C + pi; 
}

function getSolarTransit( Js, M, Lsun ) { 
  return Js + (J1 * Math.sin(M)) + (J2 * Math.sin(2 * Lsun)); 
}

// heure solaire
//Hs = Hl - DHl + DHg -E


//Hl = heure local administraative

//DHl -> decalage fuceau horaire: heure d’hiver = 2, heure d’été= 1

//DHg -> decalage longitude
//DHg = Longitude * 4 min

//DHG Venerque = 1,441823 *4
let lat = 1.44182;
let Hl = 12;
let DHl = 1;
let Dhg;
Dhg = lat * 4/60;
print( "correction lattitude Dhg : ",Dhg);

let Hs;
Hs = Hl + DHl + Dhg;
Hs = Hl + DHl + Dhg - (E/60);
//Hs = Hl + DHl + Dhg + (E);


print( "HS. : ",Hs);

let HsM = (Hs - Math.floor(Hs)) * 60;

print( "HS.minute : ",HsM);
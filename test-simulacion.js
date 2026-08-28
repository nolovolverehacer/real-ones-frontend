// test-simulacion.js
// Simula una partida completa contra el server.js de Real Ones, sin
// necesitar el frontend. Para cambiar la cantidad de jugadores, editá la
// lista JUGADORES_A_SIMULAR de abajo — el primero de la lista siempre es
// el anfitrión.
//
// Uso: node test-simulacion.js
// (con el servidor real ya corriendo en otra terminal con "npm start")

const { io } = require('socket.io-client');

const URL_SERVIDOR = 'http://localhost:3002';

const JUGADORES_A_SIMULAR = [
  { nombre: 'Ana', signo: 'ARIES' },
  { nombre: 'Beto', signo: 'TAURO' },
  { nombre: 'Cami', signo: 'GEMINIS' },
  { nombre: 'Dani', signo: 'CANCER' },
  { nombre: 'Fede', signo: 'LEO' },
  { nombre: 'Gaby', signo: 'VIRGO' }
];

let terminados = 0;
let codigoSalaGlobal = null;

function crearJugadorSimulado(nombre, signo, esAnfitrion) {
  const socket = io(URL_SERVIDOR);
  const estado = { nombre, socket, miId: null, miSala: null, esAnfitrion };

  socket.on('connect', () => {
    estado.miId = socket.id;
    if (estado.esAnfitrion) console.log(`[${nombre}] conectado (anfitrión)`);
  });

  socket.on('error_conexion', (data) => {
    console.log(`[${nombre}] ERROR: ${data.mensaje}`);
  });

  socket.on('actualizar_jugadores', (data) => {
    if (!estado.esAnfitrion) return;
    console.log(`Jugadores en sala (${data.jugadores.length}): ${data.jugadores.map(j => j.nombre).join(', ')}`);
  });

  socket.on('nueva_ronda', (data) => {
    if (estado.esAnfitrion) console.log(`\n<< Ronda ${data.numero}/${data.total} (${data.tipo})`);
    setTimeout(() => responderRonda(estado, data), 300 + Math.random() * 700);
  });

  socket.on('resultado_ronda', (data) => {
    if (estado.esAnfitrion) {
      if (data.tipo === 'FC') {
        console.log(`   >> Resultado FC: ganador = ${data.ganador ? data.ganador.nombre : 'nadie'} (${data.votos} votos)`);
      } else if (data.tipo === 'RANKING') {
        console.log(`   >> Resultado Ranking: ${data.resultado.map(r => `${r.nombre}(${r.puntos}pts)`).join(', ')}`);
      } else if (data.tipo === 'QUE_HARIA') {
        if (data.todosInocentes) {
          console.log(`   >> Resultado Qué Haría: ${data.frase}`);
        } else {
          console.log(`   >> Resultado Qué Haría: ${data.objetivos.map(o => o.nombre).join(', ')} -> "${data.textoOpcion}"`);
        }
      }
      setTimeout(() => {
        estado.socket.emit('siguiente_ronda', { codigoSala: estado.miSala });
      }, 500);
    }
  });

  socket.on('juego_terminado', (data) => {
    if (estado.esAnfitrion) {
      console.log(`\n=== JUEGO TERMINADO (${data.resultados.length} jugadores) ===`);
      [...data.resultados]
        .sort((a, b) => b.puntosDescaroTotal - a.puntosDescaroTotal)
        .forEach(r => {
          console.log(`${r.nombre} ${r.signo ? r.signo.emoji : ''} — ${r.puntosDescaroTotal} pts de Descaro`);
          console.log(`   Rol: ${r.rol.titulo}`);
          console.log(`   Alineación: ${r.alineacion.titulo}`);
          console.log(`   Mecánica dominante: ${r.mecanica.titulo}`);
        });
    }
    estado.socket.disconnect();
    terminados++;
    if (terminados >= JUGADORES_A_SIMULAR.length) {
      console.log('\nSimulación completa. Cerrando...');
      process.exit(0);
    }
  });

  return estado;
}

function responderRonda(estado, data) {
  if (data.tipo === 'FC') {
    const opciones = data.opciones.filter(o => o.id !== estado.miId);
    const elegido = opciones[Math.floor(Math.random() * opciones.length)];
    estado.socket.emit('votar_fc', { codigoSala: estado.miSala, idVotado: elegido.id });
  } else if (data.tipo === 'RANKING') {
    const otros = data.jugadores.filter(j => j.id !== estado.miId).map(j => j.id);
    const orden = otros.sort(() => Math.random() - 0.5);
    estado.socket.emit('votar_ranking', { codigoSala: estado.miSala, orden });
  } else if (data.tipo === 'QUE_HARIA') {
    const letras = data.opciones.map(o => o.letra);
    const letra = letras[Math.floor(Math.random() * letras.length)];
    estado.socket.emit('votar_que_haria', { codigoSala: estado.miSala, letra });
  }
}

function esperar(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function main() {
  const [primero, ...resto] = JUGADORES_A_SIMULAR;
  const anfitrion = crearJugadorSimulado(primero.nombre, primero.signo, true);
  await esperar(500);

  anfitrion.socket.emit('crear_sala', { nombreUsuario: primero.nombre, signo: primero.signo, token: `token-${primero.nombre}` });

  anfitrion.socket.on('sala_creada', (data) => {
    codigoSalaGlobal = data.codigoSala;
    anfitrion.miSala = data.codigoSala;
    console.log(`Sala creada: ${data.codigoSala} (esperando ${resto.length} jugadores más)`);

    const invitados = resto.map(j => crearJugadorSimulado(j.nombre, j.signo, false));

    setTimeout(() => {
      invitados.forEach((estado, i) => {
        estado.miSala = codigoSalaGlobal;
        const datos = resto[i];
        estado.socket.emit('unirse_sala', { codigoSala: codigoSalaGlobal, nombreUsuario: datos.nombre, signo: datos.signo, token: `token-${datos.nombre}` });
      });
    }, 500);

    setTimeout(() => {
      console.log('\nAnfitrión prepara el juego (mixto)...');
      anfitrion.socket.emit('preparar_juego', { codigoSala: codigoSalaGlobal, composicion: 'mixto' });
    }, 1500);

    setTimeout(() => {
      console.log('Anfitrión inicia el juego...');
      anfitrion.socket.emit('iniciar_juego', { codigoSala: codigoSalaGlobal });
    }, 2000);
  });
}

main();
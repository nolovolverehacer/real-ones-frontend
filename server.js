const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const CONTENIDO_FC = require('./contenido_fuego_cruzado.json');
const CONTENIDO_RANKING = require('./contenido_ranking.json');
const CONTENIDO_QUE_HARIA = require('./contenido_que_haria.json');
const PERFILES = require('./perfiles_finales.json');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const salas = {};

// El orden de las 12 rondas es fijo para toda partida: arranca y termina en
// Fuego Cruzado, nunca hay dos rondas no-FC seguidas.
const ORDEN_RONDAS = ['FC', 'FC', 'RANKING', 'QUE_HARIA', 'FC', 'RANKING', 'QUE_HARIA', 'FC', 'RANKING', 'QUE_HARIA', 'RANKING', 'FC'];

const TIEMPO_RONDA_MS = 65000;             // margen para responder antes del timer de respaldo
const TIEMPO_GRACIA_DESCONEXION_MS = 90000;

const SIGNOS_VALIDOS = PERFILES.signos.map(s => s.id);

function generarCodigo() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function mezclarArreglo(array) {
  let nuevo = [...array];
  for (let i = nuevo.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [nuevo[i], nuevo[j]] = [nuevo[j], nuevo[i]];
  }
  return nuevo;
}

// Elige un contenido al azar sin repetir dentro de la partida. Si ya se usó
// todo el pool, reinicia la lista de usados (para partidas muy largas).
function elegirContenido(pool, usados) {
  let disponibles = pool.filter((_, i) => !usados.includes(i));
  if (disponibles.length === 0) {
    usados.length = 0;
    disponibles = pool;
  }
  const indiceReal = pool.indexOf(disponibles[Math.floor(Math.random() * disponibles.length)]);
  usados.push(indiceReal);
  return pool[indiceReal];
}

function contarJugadoresConectados(sala) {
  return sala.jugadores.filter(j => j.conectado !== false);
}

function esAnfitrionValido(sala, socketId) {
  return sala.jugadores.some(j => j.id === socketId && j.esAnfitrion);
}

// Genera quién juzga a quién en una ronda "Qué Haría": una asignación sin
// puntos fijos (nadie se juzga a sí mismo), rearmada al azar en cada ronda.
// Esta asignación NUNCA se manda completa a ningún cliente — cada jugador
// solo recibe, en un mensaje aparte, el nombre de SU objetivo asignado.
function generarAsignacionRotativa(idsJugadores) {
  if (idsJugadores.length < 2) return {};
  let intentos = 0;
  while (intentos < 100) {
    const barajado = mezclarArreglo(idsJugadores);
    const asignacion = {};
    let valido = true;
    for (let i = 0; i < idsJugadores.length; i++) {
      if (idsJugadores[i] === barajado[i]) { valido = false; break; }
      asignacion[idsJugadores[i]] = barajado[i];
    }
    if (valido) return asignacion;
    intentos++;
  }
  // Respaldo garantizado sin puntos fijos: rotación simple.
  const asignacion = {};
  for (let i = 0; i < idsJugadores.length; i++) {
    asignacion[idsJugadores[i]] = idsJugadores[(i + 1) % idsJugadores.length];
  }
  return asignacion;
}

function limpiarTimerRonda(sala) {
  if (sala.timerRonda) { clearTimeout(sala.timerRonda); sala.timerRonda = null; }
}

io.on('connection', (socket) => {

  socket.on('crear_sala', (data) => {
    const codigo = generarCodigo();
    if (!SIGNOS_VALIDOS.includes(data.signo)) {
      return socket.emit('error_conexion', { mensaje: 'Elegí un signo válido.' });
    }
    salas[codigo] = {
      codigo,
      jugadores: [{
        id: socket.id, nombre: data.nombreUsuario, avatarSigno: data.signo, esAnfitrion: true,
        conectado: true, token: data.token || null,
        puntosDescaroFC: 0, puntosDescaroRanking: 0, puntosDescaroQueHaria: 0,
        votosCoincidentes: 0, votosTotales: 0
      }],
      composicion: null,
      cantidadJugadoresInicial: 0,
      rondaActual: 0,
      tipoRondaActual: null,
      usadosFC: [], usadosRanking: [], usadosQueHaria: [],
      respuestasFC: [], respuestasRanking: [],
      asignacionQueHaria: {}, respuestasQueHaria: {},
      rondaFinalizada: false,
      timerRonda: null,
      timersDesconexion: {}
    };
    socket.join(codigo);
    socket.emit('sala_creada', { codigoSala: codigo, jugadores: salas[codigo].jugadores });
    console.log(`[${codigo}] Sala creada por ${data.nombreUsuario}`);
  });

  socket.on('unirse_sala', (data) => {
    const sala = salas[data.codigoSala];
    if (!sala) return socket.emit('error_conexion', { mensaje: 'Sala no encontrada' });

    let existente = null;
    if (data.token) existente = sala.jugadores.find(j => j.token && j.token === data.token);
    if (!existente) {
      const nombreNormalizado = (data.nombreUsuario || '').trim().toLowerCase();
      existente = sala.jugadores.find(j => j.nombre.trim().toLowerCase() === nombreNormalizado);
    }

    if (existente) {
      const idAnterior = existente.id;
      if (sala.timersDesconexion[idAnterior]) {
        clearTimeout(sala.timersDesconexion[idAnterior]);
        delete sala.timersDesconexion[idAnterior];
      }
      existente.id = socket.id;
      existente.conectado = true;
      if (data.token) existente.token = data.token;

      // Migramos su identidad en cualquier estructura de ronda en curso.
      sala.respuestasFC.forEach(r => { if (r.idJugador === idAnterior) r.idJugador = socket.id; });
      sala.respuestasFC.forEach(r => { if (r.idVotado === idAnterior) r.idVotado = socket.id; });
      sala.respuestasRanking.forEach(r => {
        if (r.idJugador === idAnterior) r.idJugador = socket.id;
        r.orden = r.orden.map(id => id === idAnterior ? socket.id : id);
      });
      if (sala.respuestasQueHaria[idAnterior]) {
        sala.respuestasQueHaria[socket.id] = sala.respuestasQueHaria[idAnterior];
        delete sala.respuestasQueHaria[idAnterior];
      }
      if (sala.asignacionQueHaria[idAnterior]) {
        sala.asignacionQueHaria[socket.id] = sala.asignacionQueHaria[idAnterior];
        delete sala.asignacionQueHaria[idAnterior];
      }
      console.log(`[${data.codigoSala}] ${existente.nombre} se reconectó`);
    } else {
      if (!SIGNOS_VALIDOS.includes(data.signo)) {
        return socket.emit('error_conexion', { mensaje: 'Elegí un signo válido.' });
      }
      sala.jugadores.push({
        id: socket.id, nombre: data.nombreUsuario, avatarSigno: data.signo, esAnfitrion: false,
        conectado: true, token: data.token || null,
        puntosDescaroFC: 0, puntosDescaroRanking: 0, puntosDescaroQueHaria: 0,
        votosCoincidentes: 0, votosTotales: 0
      });
      console.log(`[${data.codigoSala}] ${data.nombreUsuario} se unió`);
    }

    socket.join(data.codigoSala);
    io.to(data.codigoSala).emit('actualizar_jugadores', { jugadores: sala.jugadores });
    intentarCerrarRondaSiCorresponde(data.codigoSala);
  });

  socket.on('preparar_juego', (data) => {
    const sala = salas[data.codigoSala];
    if (!sala) return;
    if (!esAnfitrionValido(sala, socket.id)) {
      return socket.emit('error_conexion', { mensaje: 'Solo el anfitrión puede iniciar el juego.' });
    }
    if (sala.jugadores.length < 3) {
      return socket.emit('error_conexion', { mensaje: 'Necesitás al menos 3 jugadores para jugar Real Ones (el anonimato lo requiere).' });
    }
    if (!['hombres', 'mujeres', 'mixto'].includes(data.composicion)) {
      return socket.emit('error_conexion', { mensaje: 'Elegí una composición de grupo válida.' });
    }
    sala.composicion = data.composicion;
    sala.cantidadJugadoresInicial = sala.jugadores.length;
    io.to(data.codigoSala).emit('pantalla_reglas', { composicion: sala.composicion });
  });

  socket.on('iniciar_juego', (data) => {
    const sala = salas[data.codigoSala];
    if (!sala) return;
    if (!esAnfitrionValido(sala, socket.id)) return;
    avanzarRonda(data.codigoSala);
  });

  socket.on('siguiente_ronda', (data) => {
    const sala = salas[data.codigoSala];
    if (!sala) return;
    if (!esAnfitrionValido(sala, socket.id)) return;
    avanzarRonda(data.codigoSala);
  });

  // ---------- Progresión de rondas ----------

  function avanzarRonda(codigoSala) {
    const sala = salas[codigoSala];
    if (!sala) return;

    limpiarTimerRonda(sala);
    sala.rondaActual++;
    sala.rondaFinalizada = false;
    sala.respuestasFC = [];
    sala.respuestasRanking = [];
    sala.asignacionQueHaria = {};
    sala.respuestasQueHaria = {};

    if (sala.rondaActual > ORDEN_RONDAS.length) {
      return terminarJuego(codigoSala);
    }

    const tipo = ORDEN_RONDAS[sala.rondaActual - 1];
    sala.tipoRondaActual = tipo;

    if (tipo === 'FC') enviarRondaFC(codigoSala);
    else if (tipo === 'RANKING') enviarRondaRanking(codigoSala);
    else if (tipo === 'QUE_HARIA') enviarRondaQueHaria(codigoSala);

    sala.timerRonda = setTimeout(() => {
      completarRespuestasFaltantes(codigoSala);
    }, TIEMPO_RONDA_MS);
  }

  // ---------- Fuego Cruzado ----------

  function enviarRondaFC(codigoSala) {
    const sala = salas[codigoSala];
    const pregunta = elegirContenido(CONTENIDO_FC, sala.usadosFC);
    const conectados = contarJugadoresConectados(sala);

    io.to(codigoSala).emit('nueva_ronda', {
      tipo: 'FC',
      texto: pregunta.texto,
      numero: sala.rondaActual,
      total: ORDEN_RONDAS.length,
      opciones: conectados.map(j => ({ id: j.id, nombre: j.nombre, avatar: j.avatarSigno }))
    });
    console.log(`[${codigoSala}] Ronda ${sala.rondaActual}/12 (FC)`);
  }

  socket.on('votar_fc', (data) => {
    try {
      const sala = salas[data.codigoSala];
      if (!sala || sala.tipoRondaActual !== 'FC') return;
      if (sala.respuestasFC.some(r => r.idJugador === socket.id)) return;

      sala.respuestasFC.push({ idJugador: socket.id, idVotado: data.idVotado });
      intentarCerrarRondaSiCorresponde(data.codigoSala);
    } catch (err) {
      console.error('Error en votar_fc:', err);
    }
  });

  function finalizarRondaFC(codigoSala) {
    const sala = salas[codigoSala];
    if (!sala || sala.rondaFinalizada) return;
    sala.rondaFinalizada = true;
    limpiarTimerRonda(sala);

    let conteo = {};
    let indiceUltimoVoto = {};
    sala.respuestasFC.forEach((r, indice) => {
      conteo[r.idVotado] = (conteo[r.idVotado] || 0) + 1;
      indiceUltimoVoto[r.idVotado] = indice;
    });

    let maxVotos = 0;
    Object.values(conteo).forEach(v => { if (v > maxVotos) maxVotos = v; });

    let idGanador = null;
    let mejorIndice = Infinity;
    Object.keys(conteo).forEach(id => {
      if (conteo[id] === maxVotos && indiceUltimoVoto[id] < mejorIndice) {
        mejorIndice = indiceUltimoVoto[id];
        idGanador = id;
      }
    });

    const ganador = sala.jugadores.find(j => j.id === idGanador);
    if (ganador) ganador.puntosDescaroFC += 10;

    sala.respuestasFC.forEach(r => {
      const votante = sala.jugadores.find(j => j.id === r.idJugador);
      if (!votante) return;
      votante.votosTotales++;
      if (r.idVotado === idGanador) votante.votosCoincidentes++;
    });

    io.to(codigoSala).emit('resultado_ronda', {
      tipo: 'FC',
      ganador: ganador ? { nombre: ganador.nombre, avatar: ganador.avatarSigno } : null,
      votos: maxVotos,
      jugadores: sala.jugadores
    });
  }

  // ---------- Ranking ----------

  function enviarRondaRanking(codigoSala) {
    const sala = salas[codigoSala];
    const pregunta = elegirContenido(CONTENIDO_RANKING, sala.usadosRanking);
    const conectados = contarJugadoresConectados(sala);

    io.to(codigoSala).emit('nueva_ronda', {
      tipo: 'RANKING',
      titulo: pregunta.titulo,
      instruccion: pregunta.instruccion,
      etiqueta_1: pregunta.etiqueta_1,
      etiqueta_ultima: pregunta.etiqueta_ultima,
      numero: sala.rondaActual,
      total: ORDEN_RONDAS.length,
      jugadores: conectados.map(j => ({ id: j.id, nombre: j.nombre, avatar: j.avatarSigno }))
    });
    console.log(`[${codigoSala}] Ronda ${sala.rondaActual}/12 (RANKING)`);
  }

  socket.on('votar_ranking', (data) => {
    try {
      const sala = salas[data.codigoSala];
      if (!sala || sala.tipoRondaActual !== 'RANKING') return;
      if (sala.respuestasRanking.some(r => r.idJugador === socket.id)) return;

      sala.respuestasRanking.push({ idJugador: socket.id, orden: data.orden });
      intentarCerrarRondaSiCorresponde(data.codigoSala);
    } catch (err) {
      console.error('Error en votar_ranking:', err);
    }
  });

  function finalizarRondaRanking(codigoSala) {
    const sala = salas[codigoSala];
    if (!sala || sala.rondaFinalizada) return;
    sala.rondaFinalizada = true;
    limpiarTimerRonda(sala);

    let puntosRonda = {};
    sala.respuestasRanking.forEach(r => {
      const k = r.orden.length;
      r.orden.forEach((idObjetivo, posicion) => {
        // Posición 0 (el "1" que ve el jugador) suma más puntos.
        puntosRonda[idObjetivo] = (puntosRonda[idObjetivo] || 0) + (k - posicion);
      });
    });

    Object.keys(puntosRonda).forEach(id => {
      const jugador = sala.jugadores.find(j => j.id === id);
      if (jugador) jugador.puntosDescaroRanking += puntosRonda[id];
    });

    const resultadoOrdenado = Object.keys(puntosRonda)
      .map(id => ({ jugador: sala.jugadores.find(j => j.id === id), puntos: puntosRonda[id] }))
      .filter(r => r.jugador)
      .sort((a, b) => b.puntos - a.puntos)
      .map(r => ({ nombre: r.jugador.nombre, avatar: r.jugador.avatarSigno, puntos: r.puntos }));

    io.to(codigoSala).emit('resultado_ronda', {
      tipo: 'RANKING',
      resultado: resultadoOrdenado,
      jugadores: sala.jugadores
    });
  }

  // ---------- Qué Haría ----------

  function enviarRondaQueHaria(codigoSala) {
    const sala = salas[codigoSala];
    const pregunta = elegirContenido(CONTENIDO_QUE_HARIA, sala.usadosQueHaria);
    const conectados = contarJugadoresConectados(sala);

    sala.preguntaQueHariaActual = pregunta;
    sala.asignacionQueHaria = generarAsignacionRotativa(conectados.map(j => j.id));

    conectados.forEach(jugador => {
      const idObjetivo = sala.asignacionQueHaria[jugador.id];
      const objetivo = sala.jugadores.find(j => j.id === idObjetivo);
      if (!objetivo) return;
      const socketDestino = io.sockets.sockets.get(jugador.id);
      if (!socketDestino) return;
      socketDestino.emit('nueva_ronda', {
        tipo: 'QUE_HARIA',
        texto: pregunta.texto,
        objetivo: { nombre: objetivo.nombre, avatar: objetivo.avatarSigno },
        opciones: pregunta.opciones,
        numero: sala.rondaActual,
        total: ORDEN_RONDAS.length
      });
    });
    console.log(`[${codigoSala}] Ronda ${sala.rondaActual}/12 (QUE_HARIA)`);
  }

  socket.on('votar_que_haria', (data) => {
    try {
      const sala = salas[data.codigoSala];
      if (!sala || sala.tipoRondaActual !== 'QUE_HARIA') return;
      if (sala.respuestasQueHaria[socket.id]) return;
      const idObjetivo = sala.asignacionQueHaria[socket.id];
      if (!idObjetivo) return;

      sala.respuestasQueHaria[socket.id] = { idObjetivo, letra: data.letra };
      intentarCerrarRondaSiCorresponde(data.codigoSala);
    } catch (err) {
      console.error('Error en votar_que_haria:', err);
    }
  });

  const FRASES_TODOS_INOCENTES = [
    "Mmm, acá todos se hacen los santitos... ¿tan fieles son? Permitime dudarlo 👀",
    "Un grupo entero jurando inocencia. Sospechoso a más no poder.",
    "Nadie salió con culpa esta vez... raro, muy raro."
  ];

  function finalizarRondaQueHaria(codigoSala) {
    const sala = salas[codigoSala];
    if (!sala || sala.rondaFinalizada) return;
    sala.rondaFinalizada = true;
    limpiarTimerRonda(sala);

    const pregunta = sala.preguntaQueHariaActual;
    const respuestas = Object.entries(sala.respuestasQueHaria).map(([idJuez, r]) => ({ idJuez, ...r }));

    let maxSeveridad = 0;
    respuestas.forEach(r => {
      const opcion = pregunta.opciones.find(o => o.letra === r.letra);
      if (opcion && opcion.severidad > maxSeveridad) maxSeveridad = opcion.severidad;
    });

    // Alineación: comparás tu nivel de severidad elegido contra la letra más
    // elegida por el resto de la sala esa ronda (no contra tu mismo objetivo,
    // ya que cada objetivo tiene un solo juez).
    let conteoLetras = {};
    respuestas.forEach(r => { conteoLetras[r.letra] = (conteoLetras[r.letra] || 0) + 1; });
    let letraModa = null, maxConteo = 0;
    Object.keys(conteoLetras).forEach(letra => {
      if (conteoLetras[letra] > maxConteo) { maxConteo = conteoLetras[letra]; letraModa = letra; }
    });
    respuestas.forEach(r => {
      const juez = sala.jugadores.find(j => j.id === r.idJuez);
      if (!juez) return;
      juez.votosTotales++;
      if (r.letra === letraModa) juez.votosCoincidentes++;
    });

    if (maxSeveridad === 0) {
      io.to(codigoSala).emit('resultado_ronda', {
        tipo: 'QUE_HARIA',
        todosInocentes: true,
        frase: FRASES_TODOS_INOCENTES[Math.floor(Math.random() * FRASES_TODOS_INOCENTES.length)],
        jugadores: sala.jugadores
      });
      return;
    }

    const opcionSevera = pregunta.opciones.find(o => o.severidad === maxSeveridad);
    const objetivosSeveros = respuestas
      .filter(r => {
        const opcion = pregunta.opciones.find(o => o.letra === r.letra);
        return opcion && opcion.severidad === maxSeveridad;
      })
      .map(r => sala.jugadores.find(j => j.id === r.idObjetivo))
      .filter(Boolean);

    objetivosSeveros.forEach(j => { j.puntosDescaroQueHaria += maxSeveridad; });

    io.to(codigoSala).emit('resultado_ronda', {
      tipo: 'QUE_HARIA',
      todosInocentes: false,
      objetivos: objetivosSeveros.map(j => ({ nombre: j.nombre, avatar: j.avatarSigno })),
      textoOpcion: opcionSevera.texto,
      jugadores: sala.jugadores
    });
  }

  // ---------- Cierre de ronda genérico (con guarda anti-repetición) ----------

  function intentarCerrarRondaSiCorresponde(codigoSala) {
    const sala = salas[codigoSala];
    if (!sala || sala.rondaFinalizada) return;
    const conectados = contarJugadoresConectados(sala);

    if (sala.tipoRondaActual === 'FC' && sala.respuestasFC.length >= conectados.length && conectados.length > 0) {
      finalizarRondaFC(codigoSala);
    } else if (sala.tipoRondaActual === 'RANKING' && sala.respuestasRanking.length >= conectados.length && conectados.length > 0) {
      finalizarRondaRanking(codigoSala);
    } else if (sala.tipoRondaActual === 'QUE_HARIA' && Object.keys(sala.respuestasQueHaria).length >= conectados.length && conectados.length > 0) {
      finalizarRondaQueHaria(codigoSala);
    }
  }

  function completarRespuestasFaltantes(codigoSala) {
    const sala = salas[codigoSala];
    if (!sala || sala.rondaFinalizada) return;
    const conectados = contarJugadoresConectados(sala);

    if (sala.tipoRondaActual === 'FC') {
      const yaVotaron = new Set(sala.respuestasFC.map(r => r.idJugador));
      conectados.forEach(j => {
        if (yaVotaron.has(j.id)) return;
        const opciones = conectados.map(o => o.id);
        sala.respuestasFC.push({ idJugador: j.id, idVotado: opciones[Math.floor(Math.random() * opciones.length)] });
      });
      finalizarRondaFC(codigoSala);
    } else if (sala.tipoRondaActual === 'RANKING') {
      const yaVotaron = new Set(sala.respuestasRanking.map(r => r.idJugador));
      conectados.forEach(j => {
        if (yaVotaron.has(j.id)) return;
        const otros = mezclarArreglo(conectados.filter(o => o.id !== j.id).map(o => o.id));
        sala.respuestasRanking.push({ idJugador: j.id, orden: otros });
      });
      finalizarRondaRanking(codigoSala);
    } else if (sala.tipoRondaActual === 'QUE_HARIA') {
      conectados.forEach(j => {
        if (sala.respuestasQueHaria[j.id]) return;
        const idObjetivo = sala.asignacionQueHaria[j.id];
        if (!idObjetivo) return;
        const opciones = sala.preguntaQueHariaActual.opciones;
        const azar = opciones[Math.floor(Math.random() * opciones.length)];
        sala.respuestasQueHaria[j.id] = { idObjetivo, letra: azar.letra };
      });
      finalizarRondaQueHaria(codigoSala);
    }
    console.log(`[${codigoSala}] Timer de respaldo disparado en ronda ${sala.rondaActual}`);
  }

  // ---------- Fin del juego y cálculo de resultados ----------

  function terminarJuego(codigoSala) {
    const sala = salas[codigoSala];
    if (!sala) return;
    limpiarTimerRonda(sala);

    const K = Math.max(sala.cantidadJugadoresInicial - 1, 1);
    const RONDAS_FC = ORDEN_RONDAS.filter(t => t === 'FC').length;
    const RONDAS_RANKING = ORDEN_RONDAS.filter(t => t === 'RANKING').length;
    const RONDAS_QUE_HARIA = ORDEN_RONDAS.filter(t => t === 'QUE_HARIA').length;

    const maxFC = RONDAS_FC * 10;
    const maxRanking = RONDAS_RANKING * K * K;
    const maxQueHaria = RONDAS_QUE_HARIA * 10;
    const maxTotal = Math.max(maxFC + maxRanking + maxQueHaria, 1);

    const rolesOrdenados = [...PERFILES.roles].sort((a, b) => b.umbral_minimo_pct - a.umbral_minimo_pct);
    const alineacionOrdenada = [...PERFILES.alineacion].sort((a, b) => b.umbral_minimo_pct - a.umbral_minimo_pct);

    const resultados = sala.jugadores.map(j => {
      const puntosDescaroTotal = j.puntosDescaroFC + j.puntosDescaroRanking + j.puntosDescaroQueHaria;
      const pctDescaro = (puntosDescaroTotal / maxTotal) * 100;
      const rol = rolesOrdenados.find(r => pctDescaro >= r.umbral_minimo_pct) || rolesOrdenados[rolesOrdenados.length - 1];

      const pctAlineacion = j.votosTotales > 0 ? (j.votosCoincidentes / j.votosTotales) * 100 : 0;
      const alineacion = alineacionOrdenada.find(a => pctAlineacion >= a.umbral_minimo_pct) || alineacionOrdenada[alineacionOrdenada.length - 1];

      let mecanicaId = 'FC';
      let mecanicaMax = j.puntosDescaroFC;
      if (j.puntosDescaroRanking > mecanicaMax) { mecanicaMax = j.puntosDescaroRanking; mecanicaId = 'RANKING'; }
      if (j.puntosDescaroQueHaria > mecanicaMax) { mecanicaMax = j.puntosDescaroQueHaria; mecanicaId = 'QUE_HARIA'; }
      const mecanica = PERFILES.mecanica_dominante.find(m => m.id === mecanicaId);

      const signo = PERFILES.signos.find(s => s.id === j.avatarSigno);

      return {
        id: j.id,
        nombre: j.nombre,
        avatarSigno: j.avatarSigno,
        puntosDescaroTotal,
        rol: { titulo: rol.titulo, descripcion: rol.descripcion },
        alineacion: { titulo: alineacion.titulo, descripcion: alineacion.descripcion },
        mecanica: { titulo: mecanica.titulo, descripcion: mecanica.descripcion },
        signo: signo ? { emoji: signo.emoji, apertura: signo.apertura } : null
      };
    });

    io.to(codigoSala).emit('juego_terminado', { resultados });
    console.log(`[${codigoSala}] Juego terminado`);
  }

  // ---------- Desconexión / reconexión (mismo patrón que Sin Careta) ----------

  function removerJugadorDefinitivamente(codigo, idJugador) {
    const sala = salas[codigo];
    if (!sala) return;
    const idx = sala.jugadores.findIndex(j => j.id === idJugador);
    if (idx === -1) return;

    const eraAnfitrion = sala.jugadores[idx].esAnfitrion;
    sala.jugadores.splice(idx, 1);
    delete sala.timersDesconexion[idJugador];

    if (sala.jugadores.length === 0) {
      limpiarTimerRonda(sala);
      delete salas[codigo];
      return;
    }

    if (eraAnfitrion) sala.jugadores[0].esAnfitrion = true;

    io.to(codigo).emit('actualizar_jugadores', { jugadores: sala.jugadores });
    intentarCerrarRondaSiCorresponde(codigo);
  }

  socket.on('disconnect', () => {
    for (const codigo in salas) {
      const sala = salas[codigo];
      const jugador = sala.jugadores.find(j => j.id === socket.id);
      if (!jugador) continue;

      jugador.conectado = false;
      io.to(codigo).emit('actualizar_jugadores', { jugadores: sala.jugadores });
      console.log(`[${codigo}] ${jugador.nombre} se desconectó, esperando reconexión...`);

      const idDesconectado = jugador.id;
      sala.timersDesconexion[idDesconectado] = setTimeout(() => {
        removerJugadorDefinitivamente(codigo, idDesconectado);
      }, TIEMPO_GRACIA_DESCONEXION_MS);

      intentarCerrarRondaSiCorresponde(codigo);
    }
  });
});

const PORT = process.env.PORT || 3002;
server.listen(PORT, () => console.log(`Servidor de Real Ones activo en puerto ${PORT}`));

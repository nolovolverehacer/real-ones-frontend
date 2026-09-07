import { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import Confetti from 'react-confetti';
import html2canvas from 'html2canvas';
import './App.css';
import { QRCodeCanvas } from 'qrcode.react';

const socket = io('https://real-ones-backend.onrender.com');

// Debe coincidir exactamente con los ids de perfiles_finales.json
const SIGNOS = [
  { id: 'ARIES', emoji: '♈', nombre: 'Aries' },
  { id: 'TAURO', emoji: '♉', nombre: 'Tauro' },
  { id: 'GEMINIS', emoji: '♊', nombre: 'Géminis' },
  { id: 'CANCER', emoji: '♋', nombre: 'Cáncer' },
  { id: 'LEO', emoji: '♌', nombre: 'Leo' },
  { id: 'VIRGO', emoji: '♍', nombre: 'Virgo' },
  { id: 'LIBRA', emoji: '♎', nombre: 'Libra' },
  { id: 'ESCORPIO', emoji: '♏', nombre: 'Escorpio' },
  { id: 'SAGITARIO', emoji: '♐', nombre: 'Sagitario' },
  { id: 'CAPRICORNIO', emoji: '♑', nombre: 'Capricornio' },
  { id: 'ACUARIO', emoji: '♒', nombre: 'Acuario' },
  { id: 'PISCIS', emoji: '♓', nombre: 'Piscis' }
];

function generarToken() {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
}

function emojiDeSigno(id) {
  const s = SIGNOS.find(s => s.id === id);
  return s ? s.emoji : '❓';
}

function App() {
  const [pantalla, setPantalla] = useState('INICIO');
  const [cargando, setCargando] = useState(false);
  const [nombre, setNombre] = useState('');
  const [signoElegido, setSignoElegido] = useState('ARIES');
  const [codigoSala, setCodigoSala] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('sala') || '';
  });

  const [miToken] = useState(() => {
    let t = localStorage.getItem('realOnes_token');
    if (!t) {
      t = generarToken();
      localStorage.setItem('realOnes_token', t);
    }
    return t;
  });

  const [jugadores, setJugadores] = useState([]);
  const [miSala, setMiSala] = useState('');
  const [miId, setMiId] = useState('');
  const [composicion, setComposicion] = useState('mixto');

  const [rondaActual, setRondaActual] = useState(null); // lo que manda 'nueva_ronda'
  const [resultadoRonda, setResultadoRonda] = useState(null); // lo que manda 'resultado_ronda'
  const [avanzando, setAvanzando] = useState(false);

  // Estado específico de cada mecánica
  const [opcionFCElegida, setOpcionFCElegida] = useState(null);
  const [ordenRanking, setOrdenRanking] = useState([]); // array de ids, en el orden tocado
  const [letraQueHariaElegida, setLetraQueHariaElegida] = useState(null);

  const [resultadosFinales, setResultadosFinales] = useState(null);

  const nombreRef = useRef(nombre);
  useEffect(() => { nombreRef.current = nombre; }, [nombre]);
  const signoRef = useRef(signoElegido);
  useEffect(() => { signoRef.current = signoElegido; }, [signoElegido]);

  // ---------- Reconexión automática (mismo patrón que Sin Careta) ----------
  useEffect(() => {
    const guardado = localStorage.getItem('realOnes_sesion');
    if (!guardado) return;
    try {
      const sesion = JSON.parse(guardado);
      if (sesion.codigoSala && sesion.nombre && sesion.signo) {
        setNombre(sesion.nombre);
        setSignoElegido(sesion.signo);
        setCodigoSala(sesion.codigoSala);
        setMiSala(sesion.codigoSala);
        setCargando(true);
        socket.emit('unirse_sala', {
          codigoSala: sesion.codigoSala,
          nombreUsuario: sesion.nombre,
          signo: sesion.signo,
          token: miToken
        });
      }
    } catch (e) {
      localStorage.removeItem('realOnes_sesion');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    socket.on('sala_creada', (data) => {
      setMiSala(data.codigoSala);
      setJugadores(data.jugadores);
      setMiId(socket.id);
      setCargando(false);
      setPantalla('LOBBY');
      localStorage.setItem('realOnes_sesion', JSON.stringify({
        codigoSala: data.codigoSala,
        nombre: nombreRef.current,
        signo: signoRef.current
      }));
    });

    socket.on('actualizar_jugadores', (data) => {
      setJugadores(data.jugadores);
      if (!miId) setMiId(socket.id);
      setCargando(false);
      setPantalla(prev => prev === 'INICIO' ? 'LOBBY' : prev);
    });

    socket.on('error_conexion', (data) => {
      alert(data.mensaje);
      setCargando(false);
      if (data.mensaje === 'Sala no encontrada') {
        localStorage.removeItem('realOnes_sesion');
      }
    });

    socket.on('pantalla_reglas', (data) => {
      setComposicion(data.composicion);
      setPantalla('REGLAS');
    });

    socket.on('nueva_ronda', (data) => {
      setRondaActual(data);
      setResultadoRonda(null);
      setOpcionFCElegida(null);
      setOrdenRanking([]);
      setLetraQueHariaElegida(null);
      setAvanzando(false);
      setPantalla('RONDA');
    });

    socket.on('resultado_ronda', (data) => {
      setResultadoRonda(data);
      if (data.jugadores) setJugadores(data.jugadores);
      setPantalla('INTERMEDIO');
    });

    socket.on('juego_terminado', (data) => {
      setResultadosFinales(data.resultados);
      setPantalla('RESULTADOS');
    });

    return () => {
      socket.off('sala_creada');
      socket.off('actualizar_jugadores');
      socket.off('error_conexion');
      socket.off('pantalla_reglas');
      socket.off('nueva_ronda');
      socket.off('resultado_ronda');
      socket.off('juego_terminado');
    };
  }, [miId]);

  // ---------- Acciones ----------

  const crearSala = () => {
    if (!nombre.trim()) return alert('¡Ponete un nombre!');
    setCargando(true);
    socket.emit('crear_sala', { nombreUsuario: nombre, signo: signoElegido, token: miToken });
  };

  const unirseSala = () => {
    if (!nombre.trim()) return alert('¡Ponete un nombre!');
    if (!codigoSala.trim()) return alert('Ingresá el código de la sala');
    const codigo = codigoSala.trim().toUpperCase();
    setCargando(true);
    socket.emit('unirse_sala', { codigoSala: codigo, nombreUsuario: nombre, signo: signoElegido, token: miToken });
    setMiSala(codigo);
    localStorage.setItem('realOnes_sesion', JSON.stringify({ codigoSala: codigo, nombre, signo: signoElegido }));
  };

  const prepararJuego = (composicionElegida) => {
    socket.emit('preparar_juego', { codigoSala: miSala, composicion: composicionElegida });
  };

  const iniciarJuego = () => {
    socket.emit('iniciar_juego', { codigoSala: miSala });
  };

  const siguienteRonda = () => {
    if (avanzando) return;
    setAvanzando(true);
    socket.emit('siguiente_ronda', { codigoSala: miSala });
  };

  const votarFC = (idVotado) => {
    if (opcionFCElegida) return;
    setOpcionFCElegida(idVotado);
    socket.emit('votar_fc', { codigoSala: miSala, idVotado });
  };

  const tocarJugadorRanking = (idJugador) => {
    if (ordenRanking.includes(idJugador)) return;
    setOrdenRanking(prev => [...prev, idJugador]);
  };

  const deshacerUltimoRanking = () => {
    setOrdenRanking(prev => prev.slice(0, -1));
  };

  const confirmarRanking = () => {
    socket.emit('votar_ranking', { codigoSala: miSala, orden: ordenRanking });
  };

  const votarQueHaria = (letra) => {
    if (letraQueHariaElegida) return;
    setLetraQueHariaElegida(letra);
    socket.emit('votar_que_haria', { codigoSala: miSala, letra });
  };

  const descargarTarjeta = () => {
    const elemento = document.getElementById('tarjeta-real-ones');
    html2canvas(elemento, { backgroundColor: '#0F041C', scale: 2 }).then((canvas) => {
      const link = document.createElement('a');
      link.download = `RealOnes_${nombre}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    });
  };

  // ---------- Derivados ----------

  const soyAnfitrion = jugadores.find(j => j.id === miId)?.esAnfitrion;
  const otrosParaRanking = rondaActual?.tipo === 'RANKING'
    ? (rondaActual.jugadores || []).filter(j => j.id !== miId)
    : [];
  const miResultadoFinal = resultadosFinales ? resultadosFinales.find(r => r.id === miId) : null;
  const rankingGeneral = resultadosFinales
    ? [...resultadosFinales].sort((a, b) => b.puntosDescaroTotal - a.puntosDescaroTotal)
    : [];

  // ---------- Estilos ----------

  const estilos = {
    contenedor: { background: 'radial-gradient(circle at 50% 0%, #2A0845 0%, #0F041C 100%)', color: '#FFFFFF', minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui, -apple-system, sans-serif', padding: '20px', boxSizing: 'border-box' },
    tarjetaGlass: { background: 'rgba(255, 255, 255, 0.03)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)', border: '1px solid rgba(255, 255, 255, 0.1)', borderRadius: '24px', padding: '30px', boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.4)', width: '100%', maxWidth: '420px', display: 'flex', flexDirection: 'column', alignItems: 'center' },
    titulo: { fontSize: '3rem', fontWeight: '900', background: 'linear-gradient(90deg, #FFD700 0%, #FF007A 50%, #7A00FF 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', margin: '0', textAlign: 'center', letterSpacing: '2px', lineHeight: '1.1' },
    subtitulo: { color: '#FFD700', marginTop: '4px', marginBottom: '24px', fontWeight: '700', fontSize: '0.95rem', letterSpacing: '2px', textTransform: 'uppercase', textAlign: 'center' },
    input: { padding: '16px', fontSize: '1.1rem', background: 'rgba(0, 0, 0, 0.2)', color: '#FFF', border: '1px solid rgba(255, 255, 255, 0.15)', borderRadius: '16px', marginBottom: '15px', width: '100%', textAlign: 'center', outline: 'none', boxSizing: 'border-box' },
    botonPrincipal: { padding: '16px 30px', fontSize: '1.15rem', fontWeight: '800', background: 'linear-gradient(45deg, #FFD700, #FF007A)', color: '#000', border: 'none', borderRadius: '30px', boxShadow: '0 4px 15px rgba(255, 0, 122, 0.4)', cursor: 'pointer', width: '100%', marginBottom: '12px' },
    botonSecundario: { padding: '16px 30px', fontSize: '1.15rem', fontWeight: '800', background: 'linear-gradient(45deg, #7A00FF, #00B8FF)', color: '#FFF', border: 'none', borderRadius: '30px', cursor: 'pointer', width: '100%', marginBottom: '12px' },
    botonOpcion: (seleccionada, bloqueado) => ({ padding: '16px', fontSize: '1.05rem', fontWeight: '600', background: seleccionada ? 'rgba(255, 215, 0, 0.15)' : 'rgba(255, 255, 255, 0.05)', color: seleccionada ? '#FFD700' : '#FFF', border: seleccionada ? '2px solid #FFD700' : '1px solid rgba(255, 255, 255, 0.1)', borderRadius: '16px', cursor: bloqueado ? 'not-allowed' : 'pointer', width: '100%', marginBottom: '10px', textAlign: 'left', opacity: (bloqueado && !seleccionada) ? 0.4 : 1 }),
    badgeSigno: (activo) => ({ fontSize: '1.8rem', padding: '10px', borderRadius: '12px', background: activo ? '#FFD700' : 'rgba(255,255,255,0.05)', border: activo ? '2px solid #FFF' : '1px solid transparent', cursor: 'pointer' }),
    ronda: { background: 'rgba(255, 255, 255, 0.1)', color: '#FFD700', padding: '6px 14px', fontWeight: '700', borderRadius: '20px', fontSize: '0.85rem', letterSpacing: '1px' },
    tarjetaReveal: { background: 'rgba(255, 215, 0, 0.08)', border: '2px solid rgba(255, 215, 0, 0.4)', borderRadius: '24px', padding: '35px 25px', textAlign: 'center', width: '100%', maxWidth: '420px', boxShadow: '0 0 40px rgba(255, 215, 0, 0.2)' }
  };

  return (
    <div style={estilos.contenedor}>
      {pantalla === 'RESULTADOS' && (
        <Confetti width={window.innerWidth} height={window.innerHeight} colors={['#FFD700', '#FF007A', '#7A00FF', '#00B8FF']} recycle={false} numberOfPieces={500} />
      )}

      {pantalla !== 'RONDA' && pantalla !== 'INTERMEDIO' && pantalla !== 'RESULTADOS' && (
        <>
          <h1 style={estilos.titulo}>REAL ONES</h1>
          <p style={estilos.subtitulo}>Amigos Reales</p>
        </>
      )}

      {pantalla === 'INICIO' && (
        <div style={estilos.tarjetaGlass}>
          <p style={{ color: '#FFF', fontWeight: 'bold', marginBottom: '10px' }}>Elegí tu signo:</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', marginBottom: '20px', width: '100%' }}>
            {SIGNOS.map(s => (
              <button key={s.id} style={estilos.badgeSigno(signoElegido === s.id)} onClick={() => setSignoElegido(s.id)} title={s.nombre}>
                {s.emoji}
              </button>
            ))}
          </div>

          <input style={estilos.input} placeholder="Tu nombre" value={nombre} onChange={(e) => setNombre(e.target.value)} maxLength={12} />
          <button style={{ ...estilos.botonPrincipal, opacity: cargando ? 0.7 : 1 }} onClick={crearSala} disabled={cargando}>
            {cargando ? 'CONECTANDO...' : 'CREAR SALA'}
          </button>

          <div style={{ margin: '15px 0', width: '100%', borderTop: '1px solid rgba(255,255,255,0.1)' }}></div>

          <input style={estilos.input} placeholder="CÓDIGO DE SALA" value={codigoSala} onChange={(e) => setCodigoSala(e.target.value)} maxLength={8} />
          <button style={{ ...estilos.botonSecundario, opacity: cargando ? 0.7 : 1 }} onClick={unirseSala} disabled={cargando}>
            {cargando ? 'CONECTANDO...' : 'UNIRSE'}
          </button>
        </div>
      )}

      {pantalla === 'LOBBY' && (
        <div style={estilos.tarjetaGlass}>
          <h2 style={{ color: '#FFD700', marginBottom: '15px', letterSpacing: '2px' }}>SALA: {miSala}</h2>

          <div style={{ background: '#FFF', padding: '10px', borderRadius: '12px', marginBottom: '20px' }}>
            <QRCodeCanvas value={`https://real-ones-frontend.vercel.app/?sala=${miSala}`} size={130} level={"H"} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', width: '100%', marginBottom: '20px' }}>
            {jugadores.map((j, i) => (
              <div key={i} style={{ background: 'rgba(0,0,0,0.4)', borderLeft: j.id === miId ? '4px solid #FFD700' : '4px solid transparent', padding: '12px 20px', borderRadius: '12px', display: 'flex', justifyContent: 'space-between', opacity: j.conectado === false ? 0.5 : 1 }}>
                <span>{emojiDeSigno(j.avatarSigno)} {j.nombre} {j.conectado === false ? '🔌' : ''}</span>
                {j.esAnfitrion && <span style={{ color: '#FFD700', fontSize: '0.8rem' }}>ANFITRIÓN</span>}
              </div>
            ))}
          </div>

          {soyAnfitrion ? (
            <div style={{ width: '100%' }}>
              <p style={{ color: '#A09FB1', fontSize: '0.85rem', marginBottom: '10px' }}>Composición del grupo:</p>
              <div style={{ display: 'flex', gap: '8px', marginBottom: '15px' }}>
                {[{ id: 'mixto', label: 'Mixto' }, { id: 'hombres', label: 'Hombres' }, { id: 'mujeres', label: 'Mujeres' }].map(c => (
                  <button key={c.id} style={{ flex: 1, padding: '10px', borderRadius: '10px', border: '1px solid #FFD700', background: composicion === c.id ? '#FFD700' : 'transparent', color: composicion === c.id ? '#000' : '#FFF', fontWeight: 'bold', cursor: 'pointer' }} onClick={() => setComposicion(c.id)}>
                    {c.label}
                  </button>
                ))}
              </div>
              <button style={estilos.botonPrincipal} onClick={() => prepararJuego(composicion)}>EMPEZAR</button>
              {jugadores.length < 3 && <p style={{ color: '#FF007A', fontSize: '0.8rem' }}>Necesitás al menos 3 jugadores</p>}
            </div>
          ) : (
            <p style={{ color: '#FFD700', fontWeight: 'bold' }}>Esperando que el anfitrión arranque...</p>
          )}
        </div>
      )}

      {pantalla === 'REGLAS' && (
        <div style={{ ...estilos.tarjetaGlass, maxWidth: '480px' }}>
          <h2 style={{ color: '#FFD700', marginBottom: '15px', fontWeight: '900', textAlign: 'center' }}>🤫 CÓMO SE JUEGA</h2>
          <div style={{ background: 'rgba(0,0,0,0.4)', padding: '20px', borderRadius: '12px', color: '#E0E0E0', fontSize: '1rem', lineHeight: '1.6', marginBottom: '20px', textAlign: 'left' }}>
            <p style={{ marginTop: 0 }}><strong>12 rondas.</strong> Vas a votar sobre gente de esta sala de tres formas distintas.</p>
            <p><strong>Nunca se revela quién votó qué.</strong> Solo se muestra el resultado — jamás quién lo eligió.</p>
            <p>Al final, cada uno recibe un perfil armado con cómo lo vieron los demás, y hay un ranking general de la partida.</p>
          </div>
          {soyAnfitrion ? (
            <button style={estilos.botonPrincipal} onClick={iniciarJuego}>EMPEZAR A JUGAR</button>
          ) : (
            <p style={{ color: '#FFD700', fontWeight: 'bold' }}>Esperando al anfitrión...</p>
          )}
        </div>
      )}

      {pantalla === 'RONDA' && rondaActual && (
        <div style={{ width: '100%', maxWidth: '480px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div style={{ marginBottom: '15px' }}>
            <span style={estilos.ronda}>Ronda {rondaActual.numero} de {rondaActual.total}</span>
          </div>

          {rondaActual.tipo === 'FC' && (
            <>
              <h2 style={{ fontSize: '1.4rem', lineHeight: '1.4', marginBottom: '25px', textAlign: 'center' }}>{rondaActual.texto}</h2>
              <div style={{ width: '100%' }}>
                {rondaActual.opciones.map(o => (
                  <button key={o.id} style={estilos.botonOpcion(opcionFCElegida === o.id, opcionFCElegida !== null)} onClick={() => votarFC(o.id)} disabled={opcionFCElegida !== null}>
                    {emojiDeSigno(o.avatar)} {o.nombre}
                  </button>
                ))}
              </div>
              {opcionFCElegida && <p style={{ color: '#A09FB1', marginTop: '10px' }}>Esperando al resto...</p>}
            </>
          )}

          {rondaActual.tipo === 'RANKING' && (
            <>
              <h2 style={{ fontSize: '1.3rem', marginBottom: '5px', textAlign: 'center', color: '#FFD700' }}>{rondaActual.titulo}</h2>
              <p style={{ fontSize: '0.95rem', color: '#E0E0E0', textAlign: 'center', marginBottom: '10px' }}>{rondaActual.instruccion}</p>
              <p style={{ fontSize: '0.8rem', color: '#A09FB1', marginBottom: '20px', textAlign: 'center' }}>
                Tocá en orden: primero {rondaActual.etiqueta_1?.toLowerCase()}, último {rondaActual.etiqueta_ultima?.toLowerCase()}
              </p>
              <div style={{ width: '100%' }}>
                {otrosParaRanking.map(j => {
                  const posicion = ordenRanking.indexOf(j.id);
                  return (
                    <button key={j.id} style={estilos.botonOpcion(posicion !== -1, ordenRanking.length === otrosParaRanking.length)} onClick={() => tocarJugadorRanking(j.id)} disabled={posicion !== -1 || ordenRanking.length === otrosParaRanking.length}>
                      {posicion !== -1 ? `${posicion + 1}° · ` : ''}{emojiDeSigno(j.avatar)} {j.nombre}
                    </button>
                  );
                })}
              </div>
              {ordenRanking.length > 0 && ordenRanking.length < otrosParaRanking.length && (
                <button style={{ ...estilos.botonSecundario, marginTop: '10px' }} onClick={deshacerUltimoRanking}>Deshacer último</button>
              )}
              {ordenRanking.length === otrosParaRanking.length && otrosParaRanking.length > 0 && (
                <button style={{ ...estilos.botonPrincipal, marginTop: '10px' }} onClick={confirmarRanking}>CONFIRMAR ORDEN</button>
              )}
            </>
          )}

          {rondaActual.tipo === 'QUE_HARIA' && (
            <>
              <h2 style={{ fontSize: '1.4rem', lineHeight: '1.4', marginBottom: '25px', textAlign: 'center' }}>{rondaActual.texto}</h2>
              <div style={{ width: '100%' }}>
                {rondaActual.opciones.map(o => (
                  <button key={o.letra} style={estilos.botonOpcion(letraQueHariaElegida === o.letra, letraQueHariaElegida !== null)} onClick={() => votarQueHaria(o.letra)} disabled={letraQueHariaElegida !== null}>
                    <strong>{o.letra})</strong> {o.texto}
                  </button>
                ))}
              </div>
              {letraQueHariaElegida && <p style={{ color: '#A09FB1', marginTop: '10px' }}>Esperando al resto...</p>}
            </>
          )}
        </div>
      )}

      {pantalla === 'INTERMEDIO' && resultadoRonda && (
        <div style={{ width: '100%', maxWidth: '480px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          {resultadoRonda.tipo === 'FC' && (
            <div style={estilos.tarjetaReveal}>
              <p style={{ color: '#A09FB1', fontWeight: '700', letterSpacing: '2px', textTransform: 'uppercase', fontSize: '0.85rem', marginBottom: '18px' }}>El grupo eligió a...</p>
              <div style={{ fontSize: '5rem', marginBottom: '12px' }}>{resultadoRonda.ganador ? emojiDeSigno(resultadoRonda.ganador.avatar) : '🤷'}</div>
              <h1 style={{ fontSize: '3.2rem', fontWeight: '900', color: '#FFD700', lineHeight: '1.1', wordBreak: 'break-word' }}>{resultadoRonda.ganador ? resultadoRonda.ganador.nombre : '—'}</h1>
              <p style={{ color: '#FF007A', fontWeight: '700', marginTop: '14px', fontSize: '1.15rem' }}>{resultadoRonda.votos} {resultadoRonda.votos === 1 ? 'voto' : 'votos'}</p>
            </div>
          )}

          {resultadoRonda.tipo === 'RANKING' && (
            <div style={{ ...estilos.tarjetaGlass }}>
              <h3 style={{ color: '#FFD700', marginBottom: '15px' }}>Resultado de la ronda</h3>
              {resultadoRonda.resultado.map((r, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', width: '100%', padding: '8px 0', borderBottom: i < resultadoRonda.resultado.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none' }}>
                  <span>{i + 1}° {emojiDeSigno(r.avatar)} {r.nombre}</span>
                  <span style={{ color: '#FFD700' }}>{r.puntos} pts</span>
                </div>
              ))}
            </div>
          )}

          {resultadoRonda.tipo === 'QUE_HARIA' && (
            resultadoRonda.todosInocentes ? (
              <div style={estilos.tarjetaReveal}>
                <p style={{ fontSize: '1.3rem', fontWeight: '700' }}>{resultadoRonda.frase}</p>
              </div>
            ) : (
              <div style={estilos.tarjetaReveal}>
                <p style={{ color: '#A09FB1', fontWeight: '700', letterSpacing: '2px', textTransform: 'uppercase', fontSize: '0.85rem', marginBottom: '18px' }}>El veredicto fue...</p>
                <h1 style={{ fontSize: '2.6rem', fontWeight: '900', color: '#FF007A', marginBottom: '14px', lineHeight: '1.15', wordBreak: 'break-word' }}>
                  {resultadoRonda.objetivos.map(o => o.nombre).join(' · ')}
                </h1>
                <p style={{ color: '#FFD700', fontStyle: 'italic', fontSize: '1.1rem' }}>"{resultadoRonda.textoOpcion}"</p>
              </div>
            )
          )}

          {soyAnfitrion ? (
            <button style={{ ...estilos.botonPrincipal, marginTop: '20px', opacity: avanzando ? 0.6 : 1 }} onClick={siguienteRonda} disabled={avanzando}>
              SIGUIENTE
            </button>
          ) : (
            <p style={{ color: '#A09FB1', marginTop: '20px' }}>Esperando que el anfitrión avance...</p>
          )}
        </div>
      )}

      {pantalla === 'RESULTADOS' && miResultadoFinal && (
        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingBottom: '40px' }}>
          <div id="tarjeta-real-ones" style={{ background: 'linear-gradient(135deg, #2A0845 0%, #0F041C 100%)', border: '2px solid rgba(255,215,0,0.5)', borderRadius: '24px', padding: '35px 25px', width: '100%', maxWidth: '380px', textAlign: 'center', marginBottom: '20px' }}>
            <div style={{ fontSize: '3rem', marginBottom: '10px' }}>{miResultadoFinal.signo?.emoji}</div>
            <p style={{ color: '#A09FB1', fontStyle: 'italic', marginBottom: '20px' }}>{miResultadoFinal.signo?.apertura}</p>

            <h1 style={{ fontSize: '1.8rem', fontWeight: '900', color: '#FFD700', marginBottom: '10px' }}>{miResultadoFinal.rol.titulo}</h1>
            <p style={{ color: '#E0E0E0', marginBottom: '20px' }}>{miResultadoFinal.rol.descripcion}</p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', background: 'rgba(0,0,0,0.3)', borderRadius: '12px', padding: '15px' }}>
              <p style={{ fontSize: '0.9rem' }}><strong style={{ color: '#FF007A' }}>{miResultadoFinal.alineacion.titulo}</strong></p>
              <p style={{ fontSize: '0.9rem' }}><strong style={{ color: '#00B8FF' }}>{miResultadoFinal.mecanica.titulo}</strong></p>
              <p style={{ fontSize: '0.85rem', color: '#A09FB1' }}>{miResultadoFinal.puntosDescaroTotal} pts de Descaro</p>
            </div>

            <p style={{ marginTop: '20px', fontSize: '0.75rem', color: '#7A00FF', fontWeight: '900', letterSpacing: '2px' }}>REAL ONES</p>
          </div>

          <button style={{ ...estilos.botonPrincipal, maxWidth: '380px' }} onClick={descargarTarjeta}>📸 GUARDAR MI TARJETA</button>

          <div style={{ width: '100%', height: '1px', background: 'rgba(255,255,255,0.1)', margin: '25px 0', maxWidth: '380px' }}></div>

          <h3 style={{ color: '#FFD700', marginBottom: '15px', letterSpacing: '1px' }}>🏆 RANKING GENERAL DE DESCARO</h3>
          <div style={{ width: '100%', maxWidth: '380px', marginBottom: '30px' }}>
            {rankingGeneral.map((r, i) => (
              <div key={r.id} style={{ background: i === 0 ? 'linear-gradient(45deg, #FF007A, #7A00FF)' : 'rgba(255,255,255,0.05)', padding: '12px 18px', borderRadius: '12px', marginBottom: '8px', display: 'flex', justifyContent: 'space-between' }}>
                <span>{i === 0 ? '👑' : `${i + 1}.`} {emojiDeSigno(r.avatarSigno)} {r.nombre}</span>
                <span>{r.puntosDescaroTotal} pts</span>
              </div>
            ))}
          </div>

          <button style={{ ...estilos.botonSecundario, maxWidth: '380px' }} onClick={() => { localStorage.removeItem('realOnes_sesion'); window.location.reload(); }}>
            VOLVER A EMPEZAR
          </button>
        </div>
      )}
    </div>
  );
}

export default App;

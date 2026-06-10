// ─── Autenticación y permisos ───
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
dotenv.config();

const SECRET = process.env.JWT_SECRET;
const EXPIRES = (process.env.JWT_EXPIRES_HORAS || '12') + 'h';

// Genera un token de sesión para un usuario.
export function firmarToken(usuario) {
  return jwt.sign(
    { id: usuario.id, usuario: usuario.usuario, rol: usuario.rol, permisos: usuario.permisos },
    SECRET,
    { expiresIn: EXPIRES }
  );
}

// Middleware: exige un token válido. Si no, corta con 401.
export function requiereLogin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No autenticado. Inicia sesión.' });
  try {
    req.usuario = jwt.verify(token, SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Sesión inválida o expirada. Vuelve a entrar.' });
  }
}

// Middleware: exige que el usuario tenga cierto permiso (ej: 'config').
export function requierePermiso(permiso) {
  return (req, res, next) => {
    if (!req.usuario?.permisos?.includes(permiso)) {
      return res.status(403).json({ error: 'No tienes permiso para esta acción.' });
    }
    next();
  };
}

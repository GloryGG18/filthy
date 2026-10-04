import { get, run, now, tx } from './db.js';
import { AppError, bus } from './tickets.js';

export function submitProof(ticket, { storyFile, profileFile, instagram }) {
  if (ticket.tier !== 'repost' || !['pending_approval', 'rejected'].includes(ticket.status)) throw new AppError('not_repost_ticket');
  const proofId = tx(() => {
    run(`UPDATE repost_proofs SET status = 'superseded' WHERE ticket_id = ? AND status = 'pending'`, ticket.id);
    run(`UPDATE tickets SET status = 'pending_approval' WHERE id = ?`, ticket.id);
    return run(
      'INSERT INTO repost_proofs (ticket_id, story_file, profile_file, instagram, created_at) VALUES (?, ?, ?, ?, ?)',
      ticket.id, storyFile, profileFile, instagram || null, now(),
    ).lastInsertRowid;
  });
  const proof = get('SELECT * FROM repost_proofs WHERE id = ?', proofId);
  bus.emit('proof_submitted', proof, get('SELECT * FROM tickets WHERE id = ?', ticket.id));
  return proof;
}

// Shared by the admin screen and the bot's one-tap buttons. Returns null if someone else already reviewed it.
export function reviewProof(proofId, adminId, approve) {
  const proof = get('SELECT * FROM repost_proofs WHERE id = ?', proofId);
  if (!proof) throw new AppError('not_found', 404);
  if (proof.status !== 'pending') return null;
  tx(() => {
    run('UPDATE repost_proofs SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?',
      approve ? 'approved' : 'rejected', adminId, now(), proofId);
    run(`UPDATE tickets SET status = ? WHERE id = ? AND status = 'pending_approval'`, approve ? 'approved' : 'rejected', proof.ticket_id);
  });
  const ticket = get('SELECT * FROM tickets WHERE id = ?', proof.ticket_id);
  bus.emit('repost_reviewed', ticket, approve);
  return { proof: get('SELECT * FROM repost_proofs WHERE id = ?', proofId), ticket };
}

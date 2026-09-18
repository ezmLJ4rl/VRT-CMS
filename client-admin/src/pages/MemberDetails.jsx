import { ArrowLeft } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import AppShell from '../components/AppShell';
import MemberProfile from '../components/MemberProfile';

export default function MemberDetails() {
  const navigate = useNavigate();
  const { id } = useParams();

  return (
    <AppShell>
      <button
        type="button"
        onClick={() => navigate('/members')}
        className="mb-4 inline-flex items-center gap-2 text-sm font-medium text-ink-600 hover:text-brand-800"
      >
        <ArrowLeft size={16} /> Back to members
      </button>
      <section className="rounded-xl border border-ink-200 bg-paper shadow-sm">
        <MemberProfile memberId={Number(id)} onClose={() => navigate('/members')} />
      </section>
    </AppShell>
  );
}

import React, { useCallback, useEffect, useState } from 'react';
import { UserRound } from 'lucide-react';
import { t } from '@/i18n';
import api from '@/services/apiClient';
import LegionFlagIcon from '@/components/common/LegionFlagIcon';

const USERS_POLL_MS = 15000;

const statusLabelOf = (status) => {
  switch (status) {
    case 'seeking':
      return t('ui.components.lobby.sidelobbyuserlist.k55e95614');
    case 'pending':
      return t('ui.components.lobby.sidelobbyuserlist.k485c0c63');
    case 'playing':
      return t('ui.components.lobby.sidelobbyuserlist.kc0a194e7');
    case 'review':
      return t('ui.components.lobby.sidelobbyuserlist.k64aae95e');
    default:
      return '';
  }
};

const getUserKey = (u) => {
  return String(
    u?.user_id ??
      u?._id ??
      u?.id ??
      u?.username ??
      u?.name ??
      Math.random().toString(36).slice(2)
  );
};

const getUserName = (u) => {
  return u?.username ?? u?.name ?? (u?.user_id != null ? t('ui.common.id_template', { id: u.user_id }) : t('ui.components.lobby.sidelobbyuserlist.kdbf11530'));
};

const getUserRating = (u) => {
  const r = Number(u?.rating ?? u?.rate);
  return Number.isFinite(r) ? r : null;
};

export default function SideLobbyUserList() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');

  const fetchUsers = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.get('/lobby/online-users');
      const list = Array.isArray(res?.data?.users) ? res.data.users : [];
      setUsers(list);
      setLoadError('');
    } catch (e) {
      if (e?.response?.status !== 401) {
        setLoadError(t('ui.components.lobby.sidelobbyuserlist.ke8fe1290'));
      }
      // eslint-disable-next-line no-console
      console.error('side-lobby online-users error', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsers();
    const id = setInterval(fetchUsers, USERS_POLL_MS);
    return () => clearInterval(id);
  }, [fetchUsers]);

  return (
    <div className="h-full flex flex-col p-3 text-sm">
      <div className="flex items-center justify-between mb-2">
        <div className="font-semibold">{t('ui.components.lobby.sidelobbyuserlist.k5b0f6739')}</div>
        <div className="text-xs text-slate-500">{t('ui.components.lobby.sidelobbyuserlist.k9aa2efd9', { count: users.length })}</div>
      </div>

      {loadError && (
        <div className="mb-2 text-xs text-red-500">{loadError}</div>
      )}

      <div className="flex-1 overflow-y-auto">
        {loading && users.length === 0 ? (
          <div className="text-xs text-slate-400">{t('ui.components.lobby.sidelobbyuserlist.kd1c13ac5')}</div>
        ) : users.length === 0 ? (
          <div className="text-xs text-slate-400">{t('ui.components.lobby.sidelobbyuserlist.k0306b239')}</div>
        ) : (
          <ul className="space-y-1">
            {users.map((u) => {
              const key = getUserKey(u);
              const name = getUserName(u);
              const rating = getUserRating(u);
              const statusLabel = statusLabelOf(u?.status);

              return (
                <li key={key} className="py-1">
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-slate-200 flex items-center justify-center">
                      <UserRound className="w-3 h-3" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate flex items-center gap-1 min-w-0">
                          <LegionFlagIcon code={u?.legion} size={14} className="flex-shrink-0" />
                          <span className="truncate">{name}</span>
                        </span>
                        {rating != null && (
                          <span className="text-xs text-slate-600">R {Math.round(rating)}</span>
                        )}
                      </div>
                      {statusLabel && (
                        <div className="text-[10px] text-slate-400">{statusLabel}</div>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

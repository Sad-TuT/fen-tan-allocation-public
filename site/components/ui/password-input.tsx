'use client';

import {useState, type ComponentProps} from 'react';
import {Eye, EyeOff} from 'lucide-react';
import {Input} from '@/components/ui/input';
import {cn} from '@/lib/utils';

type PasswordInputProps = Omit<ComponentProps<'input'>, 'type'>;

/** An independently controlled visibility toggle for each password field. */
export function PasswordInput({className, disabled, id, ...props}:PasswordInputProps){
 const [visible,setVisible]=useState(false);
 const action=visible?'隐藏密码':'显示密码';
 return <div className="password-input">
  <Input {...props} id={id} type={visible?'text':'password'} disabled={disabled} className={cn('password-input-field',className)}/>
  <button type="button" className="password-visibility" onClick={()=>setVisible(v=>!v)} disabled={disabled} aria-label={action} aria-pressed={visible} aria-controls={id} title={action}>
   {visible?<EyeOff size={19} aria-hidden="true"/>:<Eye size={19} aria-hidden="true"/>}
  </button>
 </div>;
}

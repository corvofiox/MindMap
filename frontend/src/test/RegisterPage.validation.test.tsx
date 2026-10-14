/**
 * RegisterPage — REAL client-side validation tests.
 *
 * Replaces the deleted `src/test/pages.test.ts`, which imported no project code
 * and asserted on a locally-declared `validateEmail` / `validatePassword` that
 * does not exist anywhere in the app. The real validation lives inline in
 * `RegisterPage.handleSubmit` (password match + minimum length) and gates whether
 * the API is called — so that is what is tested here, by rendering the component.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { RegisterPage } from '../pages/RegisterPage'
import { useAuthStore } from '@/store/useAuthStore'
import { useUIStore } from '@/store/useUIStore'

// Mock the auth service boundary: the page must call `register` only when its
// own client-side validation passes.
vi.mock('@/store/useAuthStore', () => ({
  useAuthStore: vi.fn(),
}))

const addToast = vi.fn()
vi.mock('@/store/useUIStore', () => ({
  useUIStore: vi.fn(),
}))

function renderPage() {
  return render(
    <MemoryRouter>
      <RegisterPage />
    </MemoryRouter>,
  )
}

function fillForm(fields: { email?: string; password?: string; confirm?: string; nickname?: string }) {
  // The inputs have stable ids (email / nickname / password / confirmPassword).
  const byId = (id: string) => document.getElementById(id) as HTMLInputElement
  const email = byId('email')
  expect(email, 'an #email input must exist').toBeDefined()
  fireEvent.change(email, { target: { value: fields.email ?? '' } })

  const nickname = byId('nickname')
  expect(nickname, 'a #nickname input must exist').toBeDefined()
  fireEvent.change(nickname, { target: { value: fields.nickname ?? '' } })

  const password = byId('password')
  expect(password, 'a #password input must exist').toBeDefined()
  fireEvent.change(password, { target: { value: fields.password ?? '' } })

  const confirm = byId('confirmPassword')
  expect(confirm, 'a #confirmPassword input must exist').toBeDefined()
  fireEvent.change(confirm, { target: { value: fields.confirm ?? fields.password ?? '' } })
}

function submit(): Promise<void> {
  const form = document.querySelector('form')
  expect(form, 'the register form must exist').toBeDefined()
  // handleSubmit is async: `await register()` settles in a microtask after the
  // submit event. Flushing inside act keeps React state updates out of warnings
  // and makes the toast assertions deterministic.
  return act(async () => {
    fireEvent.submit(form as HTMLFormElement)
  })
}

describe('RegisterPage client-side validation', () => {
  let register: ReturnType<typeof vi.fn>

  beforeEach(() => {
    cleanup()
    register = vi.fn()
    addToast.mockClear()
    ;(useAuthStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ register })
    ;(useUIStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ addToast })
  })

  it('calls register and navigates on valid input', async () => {
    register.mockResolvedValue(undefined)
    renderPage()
    fillForm({ email: 'a@b.com', password: 'longenough8', confirm: 'longenough8', nickname: 'N' })
    await submit()

    await vi.waitFor(() => {
      expect(register).toHaveBeenCalledWith({
        email: 'a@b.com',
        password: 'longenough8',
        nickname: 'N',
      })
    })
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', title: '账户创建成功！' }),
    )
  })

  it('blocks submission when the two passwords differ, without calling the API', async () => {
    renderPage()
    fillForm({ email: 'a@b.com', password: 'longenough8', confirm: 'different999' })
    await submit()

    expect(register).not.toHaveBeenCalled()
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: '密码不匹配' }),
    )
  })

  it('blocks submission when the password is shorter than 8 characters', async () => {
    renderPage()
    fillForm({ email: 'a@b.com', password: 'short7', confirm: 'short7' })
    await submit()

    expect(register).not.toHaveBeenCalled()
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: '密码太短' }),
    )
  })

  it('shows the API error message when register rejects', async () => {
    register.mockRejectedValue(new Error('该邮箱已被注册'))
    renderPage()
    fillForm({ email: 'taken@b.com', password: 'longenough8', confirm: 'longenough8' })
    await submit()

    await vi.waitFor(() => {
      expect(addToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', title: '注册失败', message: '该邮箱已被注册' }),
      )
    })
  })

  it('falls back to a generic message when the rejection is not an Error', async () => {
    register.mockRejectedValue('network down')
    renderPage()
    fillForm({ email: 'x@b.com', password: 'longenough8', confirm: 'longenough8' })
    await submit()

    await vi.waitFor(() => {
      expect(addToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', title: '注册失败', message: '请重试' }),
      )
    })
  })
})

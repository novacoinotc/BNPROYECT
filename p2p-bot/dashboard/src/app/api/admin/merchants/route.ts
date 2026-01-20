import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions, createMerchant, listMerchants, updateMerchant, deleteMerchant } from '@/lib/auth';

// GET - List all merchants (admin only)
export async function GET() {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    if (!session.user.isAdmin) {
      return NextResponse.json({ error: 'Acceso denegado' }, { status: 403 });
    }

    const merchants = await listMerchants();

    return NextResponse.json({
      success: true,
      merchants,
    });
  } catch (error) {
    console.error('Error listing merchants:', error);
    return NextResponse.json(
      { success: false, error: 'Error al listar merchants' },
      { status: 500 }
    );
  }
}

// POST - Create new merchant (admin only)
export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    if (!session.user.isAdmin) {
      return NextResponse.json({ error: 'Acceso denegado' }, { status: 403 });
    }

    const body = await request.json();

    const { name, email, password, binanceNickname, clabeAccount, bankName, isAdmin } = body;

    if (!name || !email || !password) {
      return NextResponse.json(
        { success: false, error: 'Nombre, email y password son requeridos' },
        { status: 400 }
      );
    }

    const merchant = await createMerchant({
      name,
      email,
      password,
      binanceNickname,
      clabeAccount,
      bankName,
      isAdmin: isAdmin || false,
    });

    return NextResponse.json({
      success: true,
      message: 'Merchant creado exitosamente',
      merchant,
    });
  } catch (error: any) {
    console.error('Error creating merchant:', error);

    // Check for unique constraint violation
    if (error.message?.includes('unique') || error.code === '23505') {
      return NextResponse.json(
        { success: false, error: 'Email o CLABE ya existe' },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { success: false, error: 'Error al crear merchant' },
      { status: 500 }
    );
  }
}

// PATCH - Update merchant (admin only)
export async function PATCH(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    if (!session.user.isAdmin) {
      return NextResponse.json({ error: 'Acceso denegado' }, { status: 403 });
    }

    const body = await request.json();
    const { id, ...data } = body;

    if (!id) {
      return NextResponse.json(
        { success: false, error: 'ID es requerido' },
        { status: 400 }
      );
    }

    const merchant = await updateMerchant(id, data);

    if (!merchant) {
      return NextResponse.json(
        { success: false, error: 'Merchant no encontrado' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      message: 'Merchant actualizado',
      merchant,
    });
  } catch (error: any) {
    console.error('Error updating merchant:', error);

    if (error.message?.includes('unique') || error.code === '23505') {
      return NextResponse.json(
        { success: false, error: 'Email o CLABE ya existe' },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { success: false, error: 'Error al actualizar merchant' },
      { status: 500 }
    );
  }
}

// DELETE - Delete merchant (admin only)
export async function DELETE(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user) {
      return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
    }

    if (!session.user.isAdmin) {
      return NextResponse.json({ error: 'Acceso denegado' }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json(
        { success: false, error: 'ID es requerido' },
        { status: 400 }
      );
    }

    // Prevent deleting yourself
    if (id === session.user.id) {
      return NextResponse.json(
        { success: false, error: 'No puedes eliminarte a ti mismo' },
        { status: 400 }
      );
    }

    const deleted = await deleteMerchant(id);

    if (!deleted) {
      return NextResponse.json(
        { success: false, error: 'Merchant no encontrado' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      message: 'Merchant eliminado',
    });
  } catch (error) {
    console.error('Error deleting merchant:', error);
    return NextResponse.json(
      { success: false, error: 'Error al eliminar merchant' },
      { status: 500 }
    );
  }
}
